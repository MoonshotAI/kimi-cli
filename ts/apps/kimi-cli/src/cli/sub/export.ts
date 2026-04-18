/**
 * `kimi export` sub-command — package a session as a ZIP archive.
 *
 * Python parity: `kimi_cli.cli.export`. The archive contains every file
 * under the session directory (wire.jsonl, state.json, subagents/, etc.),
 * the most recent diagnostic log files (2 days window, capped at 100MB),
 * and a generated `manifest.json` describing the export.
 *
 * DI surface (`ExportDeps`) lets tests drive the command without
 * touching `~/.kimi` or the real clock.
 */

import { createWriteStream, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { PathConfig, WIRE_PROTOCOL_VERSION } from '@moonshot-ai/core';
import type { Command } from 'commander';
import { ZipFile } from 'yazl';

import { getLogDir } from '../../config/paths.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface ExportManifest {
  readonly session_id: string;
  readonly exported_at: string;
  readonly kimi_cli_version: string;
  readonly wire_protocol_version: string;
  readonly os: string;
  readonly nodejs_version: string;
}

export interface ExportDeps {
  readonly getVersion: () => string;
  /** Resolve an absolute path to a session directory by id. */
  readonly resolveSessionDir: (sessionId: string) => string;
  /**
   * Resolve the most-recent session id for the given workDir, or
   * `undefined` when no session exists. Used when the CLI is invoked
   * without an explicit session id.
   */
  readonly findMostRecentSession: (workDir: string) => Promise<string | undefined>;
  /** Absolute path to the diagnostic log directory (`~/.kimi/logs`). */
  readonly logsDir: string;
  /** Clock — tests can freeze. */
  readonly now: () => Date;
  readonly cwd: () => string;
  readonly stdout: { write(chunk: string): boolean };
  readonly stderr: { write(chunk: string): boolean };
  readonly exit: (code: number) => never;
}

// ─── Constants ──────────────────────────────────────────────────────

const LOG_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
const MAX_LOG_BYTES = 100 * 1024 * 1024;

// ─── Handler ────────────────────────────────────────────────────────

export async function handleExport(
  deps: ExportDeps,
  sessionIdArg: string | undefined,
  outputArg: string | undefined,
): Promise<void> {
  const workDir = deps.cwd();

  let sessionId: string;
  if (sessionIdArg !== undefined && sessionIdArg.length > 0) {
    sessionId = sessionIdArg;
  } else {
    const found = await deps.findMostRecentSession(workDir);
    if (found === undefined) {
      deps.stderr.write(
        `Error: no previous session found for the working directory (${workDir}).\n`,
      );
      deps.exit(1);
    }
    sessionId = found;
  }

  const sessionDir = deps.resolveSessionDir(sessionId);
  try {
    const st = await stat(sessionDir);
    if (!st.isDirectory()) {
      deps.stderr.write(`Error: session '${sessionId}' is not a directory.\n`);
      deps.exit(1);
    }
  } catch {
    deps.stderr.write(`Error: session '${sessionId}' not found.\n`);
    deps.exit(1);
  }

  const sessionFiles = await collectFilesRecursive(sessionDir);
  if (sessionFiles.length === 0) {
    deps.stderr.write(`Error: session '${sessionId}' has no files.\n`);
    deps.exit(1);
  }

  const logFiles = await collectRecentLogFiles(deps.logsDir, deps.now());

  const manifest: ExportManifest = buildManifest({
    sessionId,
    now: deps.now(),
    version: deps.getVersion(),
  });

  const outputPath = resolveOutputPath(outputArg, sessionId, deps.cwd());
  await mkdir(dirname(outputPath), { recursive: true });

  await writeZip({
    outputPath,
    manifest,
    sessionDir,
    sessionFiles,
    logFiles,
  });

  deps.stdout.write(outputPath + '\n');
  if (logFiles.length > 0) {
    deps.stderr.write(
      'Note: this archive includes recent diagnostic logs, which may contain ' +
        'file paths, commands, or configuration from other sessions. Review ' +
        'the contents before sharing.\n',
    );
  }
}

// ─── Internal helpers ───────────────────────────────────────────────

async function collectFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

async function collectRecentLogFiles(logsDir: string, now: Date): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(logsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const cutoff = now.getTime() - LOG_RETENTION_MS;
  const nowMs = now.getTime();

  interface Candidate {
    readonly path: string;
    readonly mtime: number;
    readonly size: number;
  }
  const candidates: Candidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith('kimi.') || !entry.name.endsWith('.log')) continue;
    const full = join(logsDir, entry.name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoff) continue;
    candidates.push({ path: full, mtime: st.mtimeMs, size: st.size });
  }
  candidates.sort((a, b) => Math.abs(a.mtime - nowMs) - Math.abs(b.mtime - nowMs));
  const selected: Candidate[] = [];
  let total = 0;
  for (const c of candidates) {
    if (total + c.size > MAX_LOG_BYTES) break;
    selected.push(c);
    total += c.size;
  }
  selected.sort((a, b) => a.mtime - b.mtime);
  return selected.map((c) => c.path);
}

function buildManifest(args: {
  readonly sessionId: string;
  readonly now: Date;
  readonly version: string;
}): ExportManifest {
  return {
    session_id: args.sessionId,
    exported_at: args.now.toISOString(),
    kimi_cli_version: args.version,
    wire_protocol_version: WIRE_PROTOCOL_VERSION,
    os: `${process.platform} ${process.arch}`,
    nodejs_version: process.version.replace(/^v/, ''),
  };
}

function resolveOutputPath(
  outputArg: string | undefined,
  sessionId: string,
  cwd: string,
): string {
  if (outputArg !== undefined && outputArg.length > 0) {
    return resolve(cwd, outputArg);
  }
  const shortId = sessionId.length <= 8 ? sessionId : sessionId.slice(0, 8);
  return resolve(cwd, `session-${shortId}.zip`);
}

async function writeZip(args: {
  readonly outputPath: string;
  readonly manifest: ExportManifest;
  readonly sessionDir: string;
  readonly sessionFiles: readonly string[];
  readonly logFiles: readonly string[];
}): Promise<void> {
  const zip = new ZipFile();
  zip.addBuffer(
    Buffer.from(JSON.stringify(args.manifest, null, 2), 'utf-8'),
    'manifest.json',
  );
  for (const abs of args.sessionFiles) {
    const rel = relative(args.sessionDir, abs);
    // yazl wants POSIX separators inside the archive.
    const metadataPath = rel.split(/[\\/]/).join('/');
    // Session dirs are tiny (wire.jsonl + state.json + a few subagent
    // entries); load each into memory so we don't have to juggle stream
    // ordering against yazl's back-pressure signals.
    const data = await readFile(abs);
    zip.addBuffer(data, metadataPath);
  }
  for (const abs of args.logFiles) {
    const base = abs.split(/[\\/]/).pop() ?? abs;
    const data = await readFile(abs);
    zip.addBuffer(data, `logs/${base}`);
  }
  zip.end();
  await pipeline(
    zip.outputStream as unknown as Readable,
    createWriteStream(args.outputPath),
  );
}

// ─── Default DI ─────────────────────────────────────────────────────

function buildDefaultDeps(): ExportDeps {
  const pathConfig = new PathConfig();
  return {
    getVersion: defaultGetVersion,
    resolveSessionDir: (id) => pathConfig.sessionDir(id),
    findMostRecentSession: async (workDir) =>
      defaultFindMostRecentSession(pathConfig, workDir),
    logsDir: getLogDir(),
    now: () => new Date(),
    cwd: () => process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    exit: (code: number): never => {
      process.exit(code);
    },
  };
}

function defaultGetVersion(): string {
  try {
    const pkgUrl = new URL('../../../package.json', import.meta.url);
    const raw = readFileSync(fileURLToPath(pkgUrl), 'utf-8');
    const pkg: { version?: string } = JSON.parse(raw) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function defaultFindMostRecentSession(
  pathConfig: PathConfig,
  workDir: string,
): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(pathConfig.sessionsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  interface Candidate {
    readonly sessionId: string;
    readonly mtime: number;
  }
  const matches: Candidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statePath = pathConfig.statePath(entry.name);
    let st;
    try {
      st = await stat(statePath);
    } catch {
      continue;
    }
    let raw: string;
    try {
      raw = await readFile(statePath, 'utf-8');
    } catch {
      continue;
    }
    let parsed: { workspace_dir?: string; session_id?: string };
    try {
      parsed = JSON.parse(raw) as { workspace_dir?: string; session_id?: string };
    } catch {
      continue;
    }
    if (parsed.workspace_dir !== workDir) continue;
    matches.push({
      sessionId: parsed.session_id ?? entry.name,
      mtime: st.mtimeMs,
    });
  }
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches[0]?.sessionId;
}

// ─── Command registration ───────────────────────────────────────────

export function registerExportCommand(parent: Command, deps?: ExportDeps): void {
  const resolved = deps ?? buildDefaultDeps();
  parent
    .command('export')
    .description('Export a session as a ZIP archive.')
    .argument('[session-id]', 'Session ID to export.')
    .option('-o, --output <path>', 'Output file path.')
    .option('-y, --yes', 'Overwrite without confirmation.', false)
    .action(async (sessionId: string | undefined, opts: { output?: string }) => {
      await handleExport(resolved, sessionId, opts.output);
    });
}
