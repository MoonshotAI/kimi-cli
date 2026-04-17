/**
 * GrepTool — content search via ripgrep (§9-F / Appendix E.5).
 *
 * Shells out to `rg` through Kaos. Supports glob/type filtering, context
 * lines, output modes, head_limit, multiline, and case-insensitive search.
 * Path safety is enforced before any Kaos I/O (§14.3 D11): searches
 * targeting paths outside the workspace are rejected.
 *
 * Slice 4 audit M6 hardening (ports Python `grep_local.py`):
 *   - `timeout` via `AbortSignal` + `Promise.race`; kill rg subprocess on
 *     timeout or ambient abort using a two-phase (SIGTERM → SIGKILL) kill
 *     reused from BashTool.
 *   - 10 MB stdout/stderr cap with explicit truncation marker; the stream
 *     continues to drain so rg does not block on a full pipe.
 *   - `head_limit=0` → unlimited (Appendix E.5).
 *   - `offset` implemented as post-processing pagination.
 *   - Sensitive-file filter applied per output line (not a blanket deny):
 *     lines that belong to `.env` / `id_rsa` / etc. are dropped, with a
 *     warning appended to the tool result.
 */

import type { Readable } from 'node:stream';

import type { Kaos, KaosProcess } from '@moonshot-ai/kaos';
import type { z } from 'zod';

import type { ToolResult, ToolUpdate, ToolMetadata } from '../soul/types.js';
import { PathSecurityError, assertPathAllowed } from './path-guard.js';
import { isSensitiveFile } from './sensitive.js';
import { GrepInputSchema } from './types.js';
import type { BuiltinTool, GrepInput, GrepOutput } from './types.js';
import type { WorkspaceConfig } from './workspace.js';

const DEFAULT_TIMEOUT_MS = 20_000;
const SIGTERM_GRACE_MS = 5_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

// Line formats produced by ripgrep:
//   content match:   "file.py:10:matched text"
//   context line:    "file.py-10-context text"
//   context divider: "--"
// The separator is `:` or `-` followed by a line number then the same
// separator again. The capture group returns the file path.
const CONTENT_LINE_RE = /^(.*?)([:-])(\d+)\2/;

export class GrepTool implements BuiltinTool<GrepInput, GrepOutput> {
  readonly name = 'Grep' as const;
  readonly metadata: ToolMetadata = { source: 'builtin' };
  readonly description = 'Search file contents using regular expressions (powered by ripgrep).';
  readonly inputSchema: z.ZodType<GrepInput> = GrepInputSchema;
  // Phase 15 L14 — read-only; safe to prefetch under streaming.
  readonly isConcurrencySafe = (_input: unknown): boolean => true;

  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
  ) {}

  async execute(
    _toolCallId: string,
    args: GrepInput,
    signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<GrepOutput>> {
    if (signal.aborted) {
      return { isError: true, content: 'Aborted before search started' };
    }

    let safePath: string;
    try {
      const rawPath = args.path ?? this.workspace.workspaceDir;
      // Per-path sensitive-file filtering happens after rg produces output
      // (we need to see *which* files were hit). The directory root itself
      // is not sensitivity-checked — it is almost always a dir, not a file.
      safePath = assertPathAllowed(rawPath, this.workspace.workspaceDir, this.workspace, {
        mode: 'search',
        checkSensitive: false,
      });
    } catch (error) {
      if (error instanceof PathSecurityError) {
        return { isError: true, content: error.message };
      }
      throw error;
    }

    const rgArgs = buildRgArgs(args, safePath);

    let proc: KaosProcess;
    try {
      proc = await this.kaos.exec(...rgArgs);
    } catch (error) {
      return {
        isError: true,
        content: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      proc.stdin.end();
    } catch {
      /* already gone */
    }

    let timedOut = false;
    let aborted = false;
    let killed = false;

    const killProc = async (): Promise<void> => {
      if (killed) return;
      killed = true;
      try {
        await proc.kill('SIGTERM');
      } catch {
        /* process already gone */
      }
      const exited = proc
        .wait()
        .then(() => true)
        .catch(() => true);
      const raced = await Promise.race([
        exited,
        new Promise<false>((resolve) => {
          setTimeout(() => {
            resolve(false);
          }, SIGTERM_GRACE_MS);
        }),
      ]);
      if (!raced && proc.exitCode === null) {
        try {
          await proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    };

    const onAbort = (): void => {
      aborted = true;
      void killProc();
    };
    signal.addEventListener('abort', onAbort);

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      void killProc();
    }, DEFAULT_TIMEOUT_MS);

    let exitCode = 0;
    let stdoutText = '';
    let bufferTruncated = false;

    try {
      const [stdoutResult, , code] = await Promise.all([
        readStreamWithCap(proc.stdout, MAX_OUTPUT_BYTES),
        readStreamWithCap(proc.stderr, MAX_OUTPUT_BYTES),
        proc.wait(),
      ]);
      stdoutText = stdoutResult.text;
      bufferTruncated = stdoutResult.truncated;
      exitCode = code;
    } catch (error) {
      return {
        isError: true,
        content: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeoutHandle);
      signal.removeEventListener('abort', onAbort);
    }

    if (aborted) {
      return { isError: true, content: 'Grep aborted' };
    }

    // rg exit codes: 0 = matches, 1 = no matches, 2 = error. When we
    // killed the process for timeout, exitCode is typically 143 (SIGTERM);
    // treat that as "partial, not error" so the caller still sees what
    // rg managed to produce.
    if (exitCode === 2 && !timedOut) {
      return { isError: true, content: 'ripgrep error' };
    }

    const mode = args.output_mode ?? 'files_with_matches';

    // Normalize stdout into lines (no trailing empty line).
    const rawLines = splitRgLines(stdoutText);

    // Per-line sensitive-file filtering. For content/count modes we
    // extract the file path from each line; for files_with_matches the
    // whole line *is* the file path.
    const filteredSensitive = new Set<string>();
    const keptLines = filterSensitiveLines(rawLines, mode, filteredSensitive);

    // Apply offset + head_limit pagination. head_limit=0 (or undefined)
    // means unlimited (v2 Appendix E.5).
    const offset = args.offset ?? 0;
    const headLimit = args.head_limit;
    const afterOffset = offset > 0 ? keptLines.slice(offset) : keptLines;
    const limitActive = headLimit !== undefined && headLimit > 0;
    const limited = limitActive ? afterOffset.slice(0, headLimit) : afterOffset;
    const paginationTruncated = limitActive && afterOffset.length > (headLimit ?? 0);

    // Build the "message" — a human-readable annotation appended to the
    // tool's content, used to surface sensitive-file drops, pagination
    // hints, and buffer truncation warnings.
    const messages: string[] = [];
    if (filteredSensitive.size > 0) {
      messages.push(
        `Filtered ${String(filteredSensitive.size)} sensitive file(s): ${[...filteredSensitive].join(', ')}`,
      );
    }
    if (paginationTruncated) {
      const total = afterOffset.length + offset;
      const nextOffset = offset + (headLimit ?? 0);
      messages.push(
        `Results truncated to ${String(headLimit ?? 0)} lines (total: ${String(total)}). Use offset=${String(nextOffset)} to see more.`,
      );
    }
    if (bufferTruncated) {
      messages.push(`[stdout truncated at ${String(MAX_OUTPUT_BYTES)} bytes]`);
    }
    if (timedOut) {
      messages.push(`Grep timed out after ${String(DEFAULT_TIMEOUT_MS / 1000)}s; partial results`);
    }

    const contentBody = limited.join('\n');
    const combined =
      messages.length > 0
        ? contentBody === ''
          ? messages.join('\n')
          : `${contentBody}\n${messages.join('\n')}`
        : contentBody;

    if (mode === 'files_with_matches') {
      return {
        content: combined,
        output: { mode, numFiles: limited.length, filenames: limited },
      };
    }
    if (mode === 'count') {
      let totalMatches = 0;
      const fileSet = new Set<string>();
      for (const line of limited) {
        const idx = line.lastIndexOf(':');
        if (idx <= 0) continue;
        const n = Number.parseInt(line.slice(idx + 1), 10);
        if (!Number.isNaN(n)) totalMatches += n;
        fileSet.add(line.slice(0, idx));
      }
      return {
        content: combined,
        output: {
          mode,
          numFiles: fileSet.size,
          filenames: [...fileSet],
          numMatches: totalMatches,
        },
      };
    }

    // content mode
    const fileSet = new Set<string>();
    for (const line of limited) {
      const m = CONTENT_LINE_RE.exec(line);
      if (m !== null && m[1] !== undefined) fileSet.add(m[1]);
    }
    return {
      content: combined,
      output: {
        mode: 'content',
        numFiles: fileSet.size,
        filenames: [...fileSet],
        content: contentBody,
        numLines: limited.length,
        ...(limitActive ? { appliedLimit: headLimit } : {}),
      },
    };
  }

  getActivityDescription(args: GrepInput): string {
    const searchPath = args.path ?? '.';
    return `Searching for '${args.pattern}' in ${searchPath}`;
  }
}

function buildRgArgs(args: GrepInput, searchPath: string): string[] {
  const cmd: string[] = ['rg'];

  const mode = args.output_mode ?? 'files_with_matches';
  if (mode === 'files_with_matches') cmd.push('-l');
  else if (mode === 'count') cmd.push('-c');

  if (args['-i']) cmd.push('-i');
  if (args['-n'] !== false && mode === 'content') cmd.push('-n');
  if (args['-A'] !== undefined) cmd.push('-A', String(args['-A']));
  if (args['-B'] !== undefined) cmd.push('-B', String(args['-B']));
  if (args['-C'] !== undefined) cmd.push('-C', String(args['-C']));
  if (args.glob !== undefined) cmd.push('--glob', args.glob);
  if (args.type !== undefined) cmd.push('--type', args.type);
  if (args.multiline) cmd.push('-U', '--multiline-dotall');
  if (args.include_ignored) cmd.push('--no-ignore');
  // `head_limit` is NOT forwarded to `rg --max-count`: head_limit=0 means
  // "unlimited" (Appendix E.5), while `rg --max-count 0` means "zero
  // matches per file". Pagination happens in post-processing after rg
  // returns the full match stream.

  cmd.push('--', args.pattern, searchPath);
  return cmd;
}

function splitRgLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  // Strip the trailing empty line left by a final newline.
  while (lines.length > 0 && lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

function filterSensitiveLines(
  lines: readonly string[],
  mode: 'content' | 'files_with_matches' | 'count',
  filteredPaths: Set<string>,
): string[] {
  const kept: string[] = [];
  for (const line of lines) {
    if (mode === 'content' && line === '--') {
      kept.push(line);
      continue;
    }
    const filePath = extractFilePath(line, mode);
    if (filePath !== undefined && isSensitiveFile(filePath)) {
      filteredPaths.add(filePath);
      continue;
    }
    kept.push(line);
  }
  // A dangling "--" separator at the tail is meaningless after filtering.
  while (kept.length > 0 && kept.at(-1) === '--') {
    kept.pop();
  }
  return kept;
}

function extractFilePath(
  line: string,
  mode: 'content' | 'files_with_matches' | 'count',
): string | undefined {
  if (mode === 'files_with_matches') return line;
  if (mode === 'count') {
    const idx = line.lastIndexOf(':');
    return idx > 0 ? line.slice(0, idx) : line;
  }
  const m = CONTENT_LINE_RE.exec(line);
  return m?.[1];
}

interface CappedStreamResult {
  readonly text: string;
  readonly truncated: boolean;
}

async function readStreamWithCap(stream: Readable, maxBytes: number): Promise<CappedStreamResult> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const buf: Buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
    if (truncated) continue;
    if (total + buf.length > maxBytes) {
      const remaining = maxBytes - total;
      if (remaining > 0) chunks.push(buf.subarray(0, remaining));
      total = maxBytes;
      truncated = true;
      continue;
    }
    chunks.push(buf);
    total += buf.length;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}
