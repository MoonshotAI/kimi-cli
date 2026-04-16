/**
 * Hook config loader — parse [[hooks]] entries from KimiConfig.
 *
 * Python parity: `kimi_cli/hooks/config.py` HookDef model +
 * `kimi_cli/config.py:223` hooks field on Config.
 *
 * TOML format:
 *   [[hooks]]
 *   event = "PreToolUse"
 *   command = "my-hook.sh"
 *   matcher = "Bash"
 *   timeout = 30
 */

import type { CommandHookConfig, HookEventType } from './types.js';

const VALID_EVENTS = new Set<string>([
  'PreToolUse',
  'PostToolUse',
  'OnToolFailure',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
  'PreCompact',
  'PostCompact',
]);

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_S = 1;
const MAX_TIMEOUT_S = 600;

/**
 * Parse raw hook entries from config into typed CommandHookConfig[].
 * Invalid entries are skipped with a warning (fail-open, Python parity).
 *
 * @param raw - The `hooks` array from KimiConfig (parsed from TOML)
 * @param onWarning - Optional callback for invalid entries
 */
export function parseHookConfigs(
  raw: unknown[] | undefined,
  onWarning?: (message: string) => void,
): CommandHookConfig[] {
  if (raw === undefined || raw.length === 0) return [];

  const result: CommandHookConfig[] = [];

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (entry === null || typeof entry !== 'object') {
      onWarning?.(`hooks[${i}]: expected object, got ${typeof entry}`);
      continue;
    }

    const obj = entry as Record<string, unknown>;

    // event: required, must be valid HookEventType
    const event = obj['event'];
    if (typeof event !== 'string' || !VALID_EVENTS.has(event)) {
      onWarning?.(
        `hooks[${i}]: invalid event "${String(event)}". Valid: ${[...VALID_EVENTS].join(', ')}`,
      );
      continue;
    }

    // command: required, non-empty string
    const command = obj['command'];
    if (typeof command !== 'string' || command.trim() === '') {
      onWarning?.(`hooks[${i}]: missing or empty "command" field`);
      continue;
    }

    // matcher: optional string (default: match-all)
    const matcher = typeof obj['matcher'] === 'string' ? obj['matcher'] : undefined;

    // timeout: optional number in seconds (default: 30, range: 1-600)
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (obj['timeout'] !== undefined) {
      const timeoutS = Number(obj['timeout']);
      if (Number.isFinite(timeoutS) && timeoutS >= MIN_TIMEOUT_S && timeoutS <= MAX_TIMEOUT_S) {
        timeoutMs = timeoutS * 1000;
      } else {
        onWarning?.(
          `hooks[${i}]: timeout ${String(obj['timeout'])} out of range [${MIN_TIMEOUT_S}, ${MAX_TIMEOUT_S}], using default ${DEFAULT_TIMEOUT_MS / 1000}s`,
        );
      }
    }

    result.push({
      type: 'command',
      event: event as HookEventType,
      command: command.trim(),
      ...(matcher !== undefined ? { matcher } : {}),
      timeoutMs,
    });
  }

  return result;
}
