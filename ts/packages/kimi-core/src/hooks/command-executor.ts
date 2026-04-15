/**
 * CommandHookExecutor — server-side shell command hook (§9-C.2).
 *
 * Executes a shell command with hook context passed via stdin (JSON).
 * Exit code semantics (aligned with Python kimi-cli):
 *   - 0 = allow (ok: true)
 *   - 2 = block (ok: true, blockAction: true, reason from stderr)
 *   - timeout = allow (fail-open)
 *   - other error = allow (fail-open)
 *
 * Environment variables set for the subprocess:
 *   - KIMI_HOOK_EVENT — the event type (e.g. "PostToolUse")
 *   - KIMI_HOOK_TOOL_NAME — the tool name
 *   - KIMI_HOOK_TOOL_CALL_ID — the tool call ID
 *
 * Audit M2 hardening (ports Python `hooks/runner.py:23-55`):
 *   - Hook input is serialized as JSON and written to stdin before closing
 *     it, matching the Python `proc.communicate(json.dumps(input))` path.
 *   - `cmdHook.cwd` becomes the subprocess cwd (via a `cd` prefix — kaos
 *     does not expose a per-exec cwd option).
 *   - `hook.timeoutMs` is honored via Promise.race + two-phase kill.
 *   - The ambient `signal` is honored: abort → kill → fail-open.
 */

import { text } from 'node:stream/consumers';

import type { Kaos, KaosProcess } from '@moonshot-ai/kaos';

import type {
  CommandHookConfig,
  HookConfig,
  HookExecutor,
  HookInput,
  HookResult,
} from './types.js';

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
const SIGTERM_GRACE_MS = 5_000;

const FAIL_OPEN: HookResult = { ok: true };

export class CommandHookExecutor implements HookExecutor {
  readonly type = 'command' as const;

  constructor(private readonly kaos: Kaos) {}

  async execute(hook: HookConfig, input: HookInput, signal: AbortSignal): Promise<HookResult> {
    const cmdHook = hook as CommandHookConfig;
    const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;

    if (signal.aborted) return FAIL_OPEN;

    const env: Record<string, string> = {
      KIMI_HOOK_EVENT: input.event,
      KIMI_HOOK_TOOL_NAME: input.toolCall.name,
      KIMI_HOOK_TOOL_CALL_ID: input.toolCall.id,
    };

    const wrappedCommand =
      cmdHook.cwd !== undefined
        ? `cd ${shellQuote(cmdHook.cwd)} && ${cmdHook.command}`
        : cmdHook.command;

    let proc: KaosProcess;
    try {
      proc = await this.kaos.execWithEnv(['bash', '-c', wrappedCommand], env);
    } catch {
      return FAIL_OPEN;
    }

    try {
      proc.stdin.write(JSON.stringify(input));
    } catch {
      /* stdin write failure — subprocess may have exited early */
    }
    try {
      proc.stdin.end();
    } catch {
      /* ignore */
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
        /* already gone */
      }
      const exited = proc
        .wait()
        .then(() => true)
        .catch(() => true);
      const escalated = await Promise.race([
        exited,
        new Promise<false>((resolve) => {
          setTimeout(() => {
            resolve(false);
          }, SIGTERM_GRACE_MS);
        }),
      ]);
      if (!escalated && proc.exitCode === null) {
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
      const [, stderr, exitCode] = await Promise.all([
        text(proc.stdout),
        text(proc.stderr),
        proc.wait(),
      ]);

      if (timedOut || aborted) return FAIL_OPEN;

      if (exitCode === 2) {
        return {
          ok: true,
          blockAction: true,
          reason: stderr.trim() || 'Blocked by hook',
        };
      }

      return { ok: true };
    } catch {
      return FAIL_OPEN;
    } finally {
      clearTimeout(timeoutHandle);
      signal.removeEventListener('abort', onAbort);
    }
  }
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}
