/**
 * ShellTool — execute shell commands (§9-F / Appendix E.4).
 *
 * Phase 14 §1.1 generalisation of the historical `BashTool`: a single
 * class that invokes either bash (POSIX) or Windows PowerShell according
 * to an injected `Environment`. Wire tool name stays `"Bash"` so the
 * v2 protocol is unchanged; `display.language` distinguishes dialects.
 *
 * Dependencies injected via constructor (§9-F.3):
 *   - `Kaos`        — shell execution abstraction (exec / execWithEnv)
 *   - `cwd`         — default working directory for commands
 *   - `Environment` — cross-platform probe (shellName / shellPath)
 *   - `BackgroundProcessManager?` — optional: required iff run_in_background=true
 *
 * Execution goes through Kaos, never directly via node:child_process.
 *
 * Audit M1 hardening (ports Python `tools/shell/__init__.py`):
 *   - `args.timeout` (seconds) and the ambient `signal` both drive
 *     `Promise.race`; fire-a-kill on either edge.
 *   - stdin is closed immediately so interactive commands (`cat`, `read`,
 *     `python -c 'input()'`) receive EOF instead of hanging.
 *   - Two-phase kill: SIGTERM → 5s grace → SIGKILL (Kaos honours this
 *     contract cross-platform — see v2-update §7.7).
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
  ToolMetadata
} from '../soul/types.js';
import type { Environment } from '../utils/environment.js';
import type { BackgroundProcessManager } from './background/manager.js';
import {
  isMutatingBashCommand,
  planModeBashBlockMessage,
} from './plan-mode-checker.js';
import type { PlanModeChecker } from './plan-mode-checker.js';
import { BashInputSchema } from './types.js';
import type { BashInput, BashOutput, BuiltinTool } from './types.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BACKGROUND_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const SIGTERM_GRACE_MS = 5_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

const BASH_DESCRIPTION = `Execute a bash command. Use this tool to explore the filesystem, edit files, run scripts, get system information, etc.

**Output:**
The stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command failed, the exit code will be provided in a system tag.

If \`run_in_background=true\`, the command will be started as a background task and this tool will return a task ID instead of waiting for command completion. When doing that, you must provide a short \`description\`. You will be automatically notified when the task completes. Use \`TaskOutput\` for a non-blocking status/output snapshot, and only set \`block=true\` when you explicitly want to wait for completion. Use \`TaskStop\` only if the task must be cancelled.

**Guidelines for safety and security:**
- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls.
- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running commands, you shall set \`timeout\` argument to a reasonable value.
- Avoid using \`..\` to access files or directories outside of the working directory.
- Avoid modifying files outside of the working directory unless explicitly instructed to do so.
- Never run commands that require superuser privileges unless explicitly instructed to do so.

**Guidelines for efficiency:**
- For multiple related commands, use \`&&\` to chain them in a single call, e.g. \`cd /path && ls -la\`
- Use \`;\` to run commands sequentially regardless of success/failure
- Use \`||\` for conditional execution (run second command only if first fails)
- Use pipe operations (\`|\`) and redirections (\`>\`, \`>>\`) to chain input and output between commands
- Always quote file paths containing spaces with double quotes (e.g., cd "/path with spaces/")
- Prefer \`run_in_background=true\` for long-running builds, tests, watchers, or servers when you need the conversation to continue before the command finishes.`;

const POWERSHELL_DESCRIPTION = `Execute a Windows PowerShell command. Use this tool to explore the filesystem, inspect or edit files, run Windows scripts, collect system information, etc., whenever the agent is running on Windows.

Note that you are running on Windows, so make sure to use Windows commands, paths, and conventions.

**Output:**
The stdout and stderr streams are combined and returned as a single string. Extremely long output may be truncated. When a command fails, the exit code is provided in a system tag.

If \`run_in_background=true\`, the command will be started as a background task and this tool will return a task ID instead of waiting for completion. When doing that, you must provide a short \`description\`. You will be automatically notified when the task completes. Use \`TaskOutput\` for a non-blocking status/output snapshot, and only set \`block=true\` when you explicitly want to wait for completion. Use \`TaskStop\` only if the task must be cancelled.

**Guidelines for safety and security:**
- Every tool call starts a fresh PowerShell session. Environment variables, \`cd\` changes, and command history do not persist between calls.
- Do not launch interactive programs or anything that is expected to block indefinitely; ensure each command finishes promptly. Provide a \`timeout\` argument for potentially long runs.
- Avoid using \`..\` to leave the working directory, and never touch files outside that directory unless explicitly instructed.
- Never attempt commands that require elevated (Administrator) privileges unless explicitly authorized.

**Guidelines for efficiency:**
- Chain related commands with \`;\` and use \`if ($?)\` or \`if (-not $?)\` to conditionally execute commands based on the success or failure of previous ones.
- Redirect or pipe output with \`>\`, \`>>\`, \`|\`, and leverage \`for /f\`, \`if\`, and \`set\` to build richer one-liners instead of multiple tool calls.
- Reuse built-in utilities (e.g., \`findstr\`, \`where\`) to filter, transform, or locate data in a single invocation.
- Prefer \`run_in_background=true\` for long-running builds, tests, watchers, or servers when you need the conversation to continue before the command finishes.`;

export class ShellTool implements BuiltinTool<BashInput, BashOutput> {
  readonly name = 'Bash' as const;
  readonly metadata: ToolMetadata = { source: 'builtin' };
  readonly description: string;
  readonly inputSchema: z.ZodType<BashInput> = BashInputSchema;
  readonly display: ToolDisplayHooks<BashInput, BashOutput>;

  private readonly isPowerShell: boolean;

  private readonly environment: Environment;

  private readonly planModeChecker: PlanModeChecker | undefined;

  constructor(
    private readonly kaos: Kaos,
    private readonly cwd: string,
    environmentOrBgManager?: Environment | BackgroundProcessManager,
    private readonly backgroundManager?: BackgroundProcessManager | undefined,
    options?: { planModeChecker?: PlanModeChecker | undefined },
  ) {
    this.planModeChecker = options?.planModeChecker;
    // Legacy 3-arg form (kaos, cwd, bgManager) — infer a POSIX bash env
    // so pre-Phase-14 tests and callers keep working without a mandatory
    // `detectEnvironmentFromNode()` wire-up. New callers pass the full
    // 4-arg form (kaos, cwd, env, bgManager).
    if (environmentOrBgManager !== undefined && 'shellName' in environmentOrBgManager) {
      this.environment = environmentOrBgManager;
    } else {
      if (environmentOrBgManager !== undefined && this.backgroundManager === undefined) {
        this.backgroundManager = environmentOrBgManager;
      }
      this.environment = {
        osKind:
          process.platform === 'darwin'
            ? 'macOS'
            : process.platform === 'win32'
              ? 'Windows'
              : 'Linux',
        osArch: process.arch,
        osVersion: '0',
        shellName: 'bash',
        shellPath: '/bin/bash',
      };
    }
    this.isPowerShell = this.environment.shellName === 'Windows PowerShell';
    this.description = this.isPowerShell ? POWERSHELL_DESCRIPTION : BASH_DESCRIPTION;
    const language: 'bash' | 'powershell' = this.isPowerShell ? 'powershell' : 'bash';
    this.display = {
      getUserFacingName: () => 'Bash',
      getInputDisplay: (input) => ({
        kind: 'command',
        command: input.command,
        language,
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
  }

  private shellArgs(effectiveCwd: string, command: string): readonly string[] {
    if (this.isPowerShell) {
      return [
        this.environment.shellPath,
        '-command',
        `Set-Location -LiteralPath ${psQuote(effectiveCwd)}; ${command}`,
      ];
    }
    return [
      this.environment.shellPath,
      '-c',
      `cd ${shellQuote(effectiveCwd)} && ${command}`,
    ];
  }

  private getNoninteractiveEnv(): Record<string, string> {
    const base: Record<string, string> = {
      NO_COLOR: '1',
      TERM: 'dumb',
      GIT_TERMINAL_PROMPT: '0',
    };
    return base;
  }

  private spawn(effectiveCwd: string, command: string): Promise<KaosProcess> {
    const args = this.shellArgs(effectiveCwd, command);
    // Merge ambient env + noninteractive knobs so tools like git / node
    // don't open a pager and paints don't colour the stream.
    const mergedEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...this.getNoninteractiveEnv(),
    };
    return this.kaos.execWithEnv([...args], mergedEnv);
  }

  async execute(
    _toolCallId: string,
    args: BashInput,
    signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<BashOutput>> {
    if (signal.aborted) {
      return { isError: true, content: 'Aborted before command started' };
    }

    // Phase 18 §D.5 — plan-mode hard block for mutation commands. The
    // detector leans toward under-blocking (unknown-first-word = allow)
    // so read-only explorations (`ls`, `cat`, `grep`) keep working.
    if (
      this.planModeChecker?.isPlanModeActive() === true
      && isMutatingBashCommand(args.command)
    ) {
      return { isError: true, content: planModeBashBlockMessage() };
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
      proc = await this.spawn(effectiveCwd, args.command);
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

      const stdout = appendTruncationMarker(stdoutResult);
      const stderr = appendTruncationMarker(stderrResult);
      const anyTruncated = stdoutResult.truncated || stderrResult.truncated;
      const truncationNote = anyTruncated ? '\nOutput is truncated' : '';

      if (timedOut) {
        return {
          isError: true,
          content: `Command killed by timeout (${String(Math.floor(timeoutMs / 1000))}s)${truncationNote}`,
          output: { exitCode, stdout, stderr },
        };
      }
      if (aborted) {
        return {
          isError: true,
          content: `Command aborted${truncationNote}`,
          output: { exitCode, stdout, stderr },
        };
      }

      const isError = exitCode !== 0;
      const baseContent = isError
        ? stderr || `Process exited with code ${String(exitCode)}`
        : stdout;

      return {
        isError: isError || undefined,
        content: `${baseContent}${truncationNote}`,
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
      proc = await this.spawn(effectiveCwd, args.command);
    } catch (error) {
      return {
        isError: true,
        content: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      proc.stdin.end();
    } catch {
      /* process already gone */
    }

    const taskId = this.backgroundManager.register(proc, args.command, args.description.trim(), {
      shellInfo: {
        shellName: this.environment.shellName,
        shellPath: this.environment.shellPath,
        cwd: args.cwd ?? this.cwd,
      },
    });

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

// Wire-name alias — callers importing `BashTool` continue to work.
export { ShellTool as BashTool };

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
  return result.truncated ? `${result.text}[...truncated]\n` : result.text;
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/** Single-quote escaping for PowerShell: `'` → `''`. */
function psQuote(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}
