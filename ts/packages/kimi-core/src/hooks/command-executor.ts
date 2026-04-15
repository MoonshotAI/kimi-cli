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
 */

import { text } from 'node:stream/consumers';

import type { Kaos } from '@moonshot-ai/kaos';

import type {
  CommandHookConfig,
  HookConfig,
  HookExecutor,
  HookInput,
  HookResult,
} from './types.js';

export class CommandHookExecutor implements HookExecutor {
  readonly type = 'command' as const;

  constructor(private readonly kaos: Kaos) {}

  async execute(hook: HookConfig, input: HookInput, _signal: AbortSignal): Promise<HookResult> {
    const cmdHook = hook as CommandHookConfig;
    const env: Record<string, string> = {
      KIMI_HOOK_EVENT: input.event,
      KIMI_HOOK_TOOL_NAME: input.toolCall.name,
      KIMI_HOOK_TOOL_CALL_ID: input.toolCall.id,
    };

    try {
      const proc = await this.kaos.execWithEnv(['bash', '-c', cmdHook.command], env);

      const [, stderr, exitCode] = await Promise.all([
        text(proc.stdout),
        text(proc.stderr),
        proc.wait(),
      ]);

      if (exitCode === 2) {
        return {
          ok: true,
          blockAction: true,
          reason: stderr.trim() || 'Blocked by hook',
        };
      }

      return { ok: true };
    } catch {
      // Fail-open: command error or timeout → allow
      return { ok: true };
    }
  }
}
