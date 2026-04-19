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

/**
 * Phase 18 B.3 — event-name aliases. Python's TOML config uses
 * `PostToolUseFailure`; TS canonical name is `OnToolFailure`. Accept
 * the Python spelling at parse time so cross-environment configs are
 * portable, and normalise to the canonical name so downstream
 * `executeHooks(event, …)` lookups match on a single literal.
 */
const EVENT_ALIASES: Readonly<Record<string, HookEventType>> = {
  PostToolUseFailure: 'OnToolFailure',
};

function normalizeEvent(event: string): string {
  return EVENT_ALIASES[event] ?? event;
}

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

    // event: required, must be valid HookEventType (aliases accepted).
    const rawEvent = obj['event'];
    if (typeof rawEvent !== 'string') {
      onWarning?.(
        `hooks[${i}]: invalid event "${String(rawEvent)}". Valid: ${[...VALID_EVENTS].join(', ')}`,
      );
      continue;
    }
    const event = normalizeEvent(rawEvent);
    if (!VALID_EVENTS.has(event)) {
      onWarning?.(
        `hooks[${i}]: invalid event "${rawEvent}". Valid: ${[...VALID_EVENTS].join(', ')}`,
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
        const rawTimeout = obj['timeout'];
        const displayTimeout = typeof rawTimeout === 'string' || typeof rawTimeout === 'number'
          ? String(rawTimeout)
          : '<invalid>';
        onWarning?.(
          `hooks[${i}]: timeout ${displayTimeout} out of range [${MIN_TIMEOUT_S}, ${MAX_TIMEOUT_S}], using default ${DEFAULT_TIMEOUT_MS / 1000}s`,
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
