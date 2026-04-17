/* oxlint-disable vitest/warn-todo -- Phase 12 intentionally uses it.todo
   to track src gaps. See migration-report.md §12.4. */
/**
 * Wire E2E — hooks at the wire surface (Phase 12.4).
 *
 * Migrated from Python `tests/e2e/test_hooks_wire_e2e.py` (450L, 5
 * scenarios). Unit coverage of the hook engine itself is already solid
 * (`test/hooks/{hook-engine,lifecycle-events,command-executor,wire-executor,
 * config-loader}.test.ts`); this file pins the wire-surface behaviour:
 *
 *   #1 hooks_metadata_in_initialize — `initialize` response exposes
 *      `hooks.supported_events` (13-entry TS union — v2 §3.5) +
 *      `hooks.configured = { <event>: <count> }` count map.
 *   #2 wire_hook_subscription_in_initialize — `initialize.params.hooks`
 *      list of `{id, event, matcher}` registers wire-channel hooks;
 *      `configured` reflects them. No shell executor fired.
 *   #3 hook_events_fire_during_prompt — UserPromptSubmit + Stop shell
 *      hooks → wire sees `hook.triggered` + `hook.resolved` (action:
 *      allow, duration_ms: number) for each.
 *   #4 pre_and_post_tool_use_hooks_on_tool_call — 4 lifecycle hooks fire
 *      in order: UserPromptSubmit → PreToolUse → PostToolUse → Stop, with
 *      PreToolUse/PostToolUse target matching the invoked tool (Read).
 *   #5 pre_tool_use_hook_blocks_tool — PreToolUse exit 2 + stderr
 *      "blocked" → hook.resolved action=block + reason contains
 *      "blocked" → tool.result is_error=true contains "hook"/"blocked".
 *      Windows-skipped (depends on POSIX shell script with exit code).
 *
 * Status (src gap summary — all 5 scenarios are `it.todo`):
 *   - The default `initialize` handler
 *     (`test/helpers/wire/default-handlers.ts`) does NOT include
 *     `hooks.supported_events` or `hooks.configured` in the response.
 *     Adding these is a Phase 11 deliverable (real `--wire` runner).
 *   - `InitializeRequestData.hooks` is accepted by the schema but the
 *     default handler does not register them on a session-local
 *     HookEngine.
 *   - There is no component emitting `hook.triggered` / `hook.resolved`
 *     wire events today; that bridge is a Phase 11 deliverable alongside
 *     the `hook.request` reverse-RPC the WireHookExecutor would use.
 *
 * We keep the scenarios as structured `it.todo` entries so the lift is
 * mechanical once the gaps close. Each comment pins the exact src hook
 * / file that needs to participate.
 */

import { afterEach, describe, it } from 'vitest';

import {
  createWireE2EHarness,
  type WireE2EInMemoryHarness,
} from '../helpers/index.js';

let harness: WireE2EInMemoryHarness | undefined;

afterEach(async () => {
  if (harness !== undefined) {
    await harness.dispose();
    harness = undefined;
  }
});

// The 13-entry HookEventType union (src/hooks/types.ts:32-45). Pinned
// here so when #1/#2 lift, the assertion has a shared source of truth.
export const EXPECTED_SUPPORTED_HOOK_EVENTS: readonly string[] = [
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
];

// Keep harness reference imported so the suite boots the server for
// any pre-lift debugging (`harness.sessionManager.*`).
void createWireE2EHarness;

describe('wire hooks — #1 initialize exposes hooks metadata', () => {
  it.todo(
    'initialize response contains hooks.supported_events (13 entries) + ' +
      'hooks.configured map derived from toml config ' +
      '(pending src: default-handlers.initialize does not emit hooks.* block; ' +
      'source of truth = src/hooks/types.ts HookEventType, exported above)',
  );
});

describe('wire hooks — #2 wire hook subscription in initialize', () => {
  it.todo(
    'client passes initialize.params.hooks: [{id, event, matcher}, …] → ' +
      'response hooks.configured counts each; no command executor fires ' +
      '(pending src: initialize handler needs to route hooks into a ' +
      'per-session HookEngine + register WireHookExecutor for each wire-type entry)',
  );
});

describe('wire hooks — #3 shell hooks fire during prompt', () => {
  it.todo(
    'UserPromptSubmit + Stop shell hooks attached → prompt request → wire ' +
      'sees hook.triggered + hook.resolved (action: allow, duration_ms: ' +
      'number, id matches config) for each event ' +
      '(pending src: HookEngine.executeHooks never emits wire events today; ' +
      'needs TurnManager/SessionEventBus → wire bridge for hook.triggered / ' +
      'hook.resolved. duration_ms must normalize via summarizeMessages to ' +
      'avoid flake)',
  );
});

describe('wire hooks — #4 pre+post tool-use hooks on tool call', () => {
  it.todo(
    '4 hooks (UserPromptSubmit + PreToolUse + PostToolUse + Stop) → ' +
      'prompt triggers Read tool → wire emits hook.triggered in order: ' +
      'UserPromptSubmit, PreToolUse(target:Read), PostToolUse(target:Read), ' +
      'Stop — each paired with hook.resolved action=allow ' +
      '(pending: same src gap as #3 + PreToolUse/PostToolUse target field ' +
      'on wire payload)',
  );
});

// Windows skip matches Python pytestmark=skipif(win32). `it.todo` is a
// compile-time marker and never runs, so Windows gating only matters at
// lift time — when the case becomes `it(...)`, callers must swap to
// `describe.skipIf(process.platform === 'win32')`.
describe('wire hooks — #5 PreToolUse blocks tool', () => {
  it.todo(
    'PreToolUse command: tmp shell script `exit 2` + stderr "blocked" → ' +
      'hook.resolved action=block with reason containing "blocked" → ' +
      'tool.result is_error=true contains "hook" and "blocked" (pending: ' +
      'same src gap as #3/#4 + PreToolUse blockAction → ToolResult error ' +
      'mapping on the wire surface. LIFT-TIME: gate this describe with ' +
      '`describe.skipIf(process.platform === "win32")` per Python ' +
      'pytestmark=skipif(win32))',
  );
});
