/**
 * BashTool — execute shell commands (§9-F / Appendix E.4).
 *
 * Dependencies injected via constructor (§9-F.3):
 *   - `Kaos` — shell execution abstraction (exec / execWithEnv)
 *   - `cwd`  — default working directory for commands
 *
 * Execution goes through Kaos, never directly via node:child_process.
 *
 * Audit M1 hardening (ports Python `tools/shell/__init__.py:21-35, 108-124,
 * 226-246`):
 *   - `args.timeout` (seconds) and the ambient `signal` both drive
 *     `Promise.race`; fire-a-kill on either edge.
 *   - stdin is closed immediately so interactive commands (`cat`, `read`,
 *     `python -c 'input()'`) receive EOF instead of hanging.
 *   - Two-phase kill: SIGTERM → 5s grace → SIGKILL.
 *   - stdout/stderr each capped at MAX_OUTPUT_BYTES; excess is replaced
 *     with a truncation marker so a runaway command cannot OOM the host.
 */

import type { Readable } from 'node:stream';

import type { Kaos, KaosProcess } from '@moonshot-ai/kaos';
import type { z } from 'zod';

import type {
  ToolDisplayHooks,
  ToolResult,
  ToolResultDisplay,
  ToolUpdate,
} from '../soul/types.js';
import type { BackgroundProcessManager } from './background/manager.js';
import { BashInputSchema } from './types.js';
import type { BashInput, BashOutput, BuiltinTool } from './types.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BACKGROUND_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const SIGTERM_GRACE_MS = 5_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export class BashTool implements BuiltinTool<BashInput, BashOutput> {
  readonly name = 'Bash' as const;
  readonly description = 'Execute shell commands in the workspace.';
  readonly inputSchema: z.ZodType<BashInput> = BashInputSchema;
  readonly display: ToolDisplayHooks<BashInput, BashOutput> = {
    getUserFacingName: () => 'Bash',
    getInputDisplay: (input) => ({
      kind: 'command',
      command: input.command,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    }),
    getResultDisplay: (_input, result): ToolResultDisplay => ({
      kind: 'command_output',
      exit_code: result.output?.exitCode ?? 0,
      stdout: result.output?.stdout ?? '',
      stderr: result.output?.stderr ?? '',
    }),
  };

  constructor(
    private readonly kaos: Kaos,
    private readonly cwd: string,
    private readonly backgroundManager?: BackgroundProcessManager | undefined,
  ) {}

  async execute(
    _toolCallId: string,
    args: BashInput,
    signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<BashOutput>> {
    if (signal.aborted) {
      return { isError: true, content: 'Aborted before command started' };
    }

    if (args.run_in_background) {
      return this.executeInBackground(args);
    }

    const timeoutMs = Math.min(
      args.timeout !== undefined ? args.timeout * 1000 : DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );

    let proc: KaosProcess;
    try {
      const effectiveCwd = args.cwd ?? this.cwd;
      proc = await this.kaos.exec(
        'bash',
        '-c',
        `cd ${shellQuote(effectiveCwd)} && ${args.command}`,
      );
    } catch (error) {
      return {
        isError: true,
        content: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      proc.stdin.end();
    } catch {
      // Closing stdin on a process that has already exited is a no-op on
      // some platforms and throws on others — either is safe to ignore.
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
    }, timeoutMs);

    try {
      const [stdoutResult, stderrResult, exitCode] = await Promise.all([
        readStreamWithCap(proc.stdout, MAX_OUTPUT_BYTES),
        readStreamWithCap(proc.stderr, MAX_OUTPUT_BYTES),
        proc.wait(),
      ]);

      if (timedOut) {
        return {
          isError: true,
          content: `Command killed by timeout (${String(Math.floor(timeoutMs / 1000))}s)`,
          output: {
            exitCode,
            stdout: appendTruncationMarker(stdoutResult),
            stderr: appendTruncationMarker(stderrResult),
          },
        };
      }
      if (aborted) {
        return {
          isError: true,
          content: 'Command aborted',
          output: {
            exitCode,
            stdout: appendTruncationMarker(stdoutResult),
            stderr: appendTruncationMarker(stderrResult),
          },
        };
      }

      const stdout = appendTruncationMarker(stdoutResult);
      const stderr = appendTruncationMarker(stderrResult);
      const isError = exitCode !== 0;

      return {
        isError: isError || undefined,
        content: isError ? stderr || `Process exited with code ${String(exitCode)}` : stdout,
        output: { exitCode, stdout, stderr },
      };
    } catch (error) {
      return {
        isError: true,
        content: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeoutHandle);
      signal.removeEventListener('abort', onAbort);
    }
  }

  getActivityDescription(args: BashInput): string {
    const preview = args.command.length > 50 ? `${args.command.slice(0, 50)}…` : args.command;
    return args.run_in_background ? `Starting background: ${preview}` : `Running: ${preview}`;
  }

  private async executeInBackground(args: BashInput): Promise<ToolResult<BashOutput>> {
    if (!this.backgroundManager) {
      return {
        isError: true,
        content: 'Background execution is not available (no BackgroundProcessManager configured).',
      };
    }

    if (!args.description?.trim()) {
      return {
        isError: true,
        content: 'description is required when run_in_background is true.',
      };
    }

    const timeoutMs = Math.min(
      args.timeout !== undefined ? args.timeout * 1000 : DEFAULT_TIMEOUT_MS,
      MAX_BACKGROUND_TIMEOUT_MS,
    );

    let proc: KaosProcess;
    try {
      const effectiveCwd = args.cwd ?? this.cwd;
      proc = await this.kaos.exec(
        'bash',
        '-c',
        `cd ${shellQuote(effectiveCwd)} && ${args.command}`,
      );
    } catch (error) {
      return {
        isError: true,
        content: error instanceof Error ? error.message : String(error),
      };
    }

    // Close stdin so interactive commands get EOF.
    try {
      proc.stdin.end();
    } catch {
      /* process already gone */
    }

    // Register KaosProcess directly — no unsafe cast needed.
    const taskId = this.backgroundManager.register(proc, args.command, args.description.trim());

    // Schedule background timeout kill.
    setTimeout(() => {
      const info = this.backgroundManager!.getTask(taskId);
      if (info && info.status === 'running') {
        void this.backgroundManager!.stop(taskId);
      }
    }, timeoutMs);

    return {
      isError: false,
      content:
        `task_id: ${taskId}\n` +
        `pid: ${String(proc.pid)}\n` +
        `description: ${args.description.trim()}\n` +
        `automatic_notification: true\n` +
        'next_step: You will be automatically notified when it completes.\n' +
        'next_step: Use TaskOutput with this task_id for a non-blocking status/output snapshot.\n' +
        'next_step: Use TaskStop only if the task must be cancelled.',
      output: {
        exitCode: 0,
        stdout: `Background task started: ${taskId}`,
        stderr: '',
      },
    };
  }
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

function appendTruncationMarker(result: CappedStreamResult): string {
  return result.truncated
    ? `${result.text}\n[output truncated at ${String(MAX_OUTPUT_BYTES)} bytes]`
    : result.text;
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}
