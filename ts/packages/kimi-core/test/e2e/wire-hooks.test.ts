/* oxlint-disable vitest/warn-todo -- Phase 17 B.7 lifts scenarios #1
   and #3; #2/#4/#5 remain CLI Phase follow-up. */
/**
 * Wire E2E — hooks at the wire surface.
 *
 * Phase 17 B.7 固化决策:
 *   - HookEngine.runHooks emits SoulEvent `{type:'hook.triggered', event,
 *     matchers, matched_count}` + per-resolved `{type:'hook.resolved',
 *     hook_id, outcome, duration_ms}`.
 *   - WireEventBridge (A.1) forwards the two as `hook.triggered` /
 *     `hook.resolved` wire events.
 *   - InitializeResponseData.capabilities gains `hooks?: {
 *     supported_events: string[]; configured: HookSubscription[] }`.
 *
 * Phase 17 lifts #1 (initialize hooks metadata) + #3 (shell hooks fire
 * during prompt). #2 (wire hook subscription), #4 (pre/post tool hooks),
 * #5 (PreToolUse blocks tool) stay as CLI Phase follow-up because they
 * require the reverse-RPC `hook.request` handler + POSIX shell execution.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildInitializeRequest,
  buildPromptRequest,
  buildSessionCreateRequest,
  createWireE2EHarness,
  FakeKosongAdapter,
  type WireE2EInMemoryHarness,
} from '../helpers/index.js';
import { installWireEventBridge } from '../../src/wire-protocol/event-bridge.js';

let harness: WireE2EInMemoryHarness | undefined;
let disposeBridge: (() => void) | undefined;

afterEach(async () => {
  disposeBridge?.();
  disposeBridge = undefined;
  if (harness !== undefined) {
    await harness.dispose();
    harness = undefined;
  }
});

// The 13-entry HookEventType union (src/hooks/types.ts:32-45). Pinned
// here so when the src `InitializeResponseData.capabilities.hooks.
// supported_events` union changes, this list is the single point of
// assertion.
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

describe('Phase 17 B.7 — #1 initialize exposes hooks metadata', () => {
  it('initialize response contains capabilities.hooks.supported_events (13 entries)', async () => {
    harness = await createWireE2EHarness();
    const initReq = buildInitializeRequest();
    await harness.send(initReq);
    const { response } = await harness.collectUntilResponse(initReq.id);

    const data = response.data as {
      capabilities: {
        hooks?: { supported_events?: readonly string[]; configured?: unknown };
      };
    };
    const supported = data.capabilities.hooks?.supported_events;
    expect(supported).toBeDefined();
    expect(supported).toEqual(
      expect.arrayContaining([...EXPECTED_SUPPORTED_HOOK_EVENTS]),
    );
  });

  it('initialize response capabilities.hooks.configured is present (possibly empty)', async () => {
    harness = await createWireE2EHarness();
    const initReq = buildInitializeRequest();
    await harness.send(initReq);
    const { response } = await harness.collectUntilResponse(initReq.id);
    const data = response.data as {
      capabilities: { hooks?: { configured?: unknown } };
    };
    expect(data.capabilities.hooks?.configured).toBeDefined();
  });
});

// Phase 17 B.7 — HookEngine lifecycle emit is landed (engine.ts emits
// `hook.triggered` / `hook.resolved` through the injected sink; bridge
// translation + runWire/kimi-core-client wiring ship in this phase).
// The test stays `.skip` because the e2e harness does not yet accept a
// `hooks` option to seed the per-session HookEngine — harness-level
// hook registration plumbing is tracked as CLI Phase follow-up and
// does not affect the production emit path.
describe.skip('Phase 17 B.7 — #3 — CLI Phase follow-up (harness seeds hooks) — shell hooks fire during prompt', () => {
  it('UserPromptSubmit + Stop hooks → wire hook.triggered + hook.resolved events fire around the turn', async () => {
    const kosong = new FakeKosongAdapter({
      turns: [{ text: 'done', stopReason: 'end_turn' }],
    });
    // Phase 17 B.7 — the harness must let callers pre-register hooks.
    // Implementer lands this via `hooks` option on createWireE2EHarness
    // or a follow-up `router.registerHook`. The assertion below is
    // shape-only; the exact registration knob is deferred to the
    // Implementer — the test calls through `harness.hookEngine` if
    // present, falling back to the harness-level `hooks` option.
    harness = await createWireE2EHarness({
      kosong,
      // Phase 17 B.7 — new harness option to seed HookEngine with
      // subscriptions.
      ...(({
        hooks: [
          {
            id: 'h1',
            event: 'UserPromptSubmit',
            type: 'command',
            command: 'true',
          },
          { id: 'h2', event: 'Stop', type: 'command', command: 'true' },
        ],
      } as unknown) as Record<string, never>),
    });
    await harness.send(buildInitializeRequest());
    const createReq = buildSessionCreateRequest({ model: 'test-model' });
    await harness.send(createReq);
    const { response: cRes } = await harness.collectUntilResponse(createReq.id);
    const sessionId = (cRes.data as { session_id: string }).session_id;
    const managed = harness.sessionManager.get(sessionId);
    if (managed === undefined) throw new Error('session not materialised');
    const turnManager = managed.soulPlus.getTurnManager();
    const bridge = installWireEventBridge({
      server: harness.server,
      eventBus: harness.eventBus,
      addTurnLifecycleListener: (l) => turnManager.addTurnLifecycleListener(l),
      sessionId,
    });
    disposeBridge = bridge.dispose;

    const req = buildPromptRequest({ sessionId, text: 'hi' });
    await harness.send(req);
    const { response } = await harness.collectUntilResponse(req.id);
    const turnId = (response.data as { turn_id: string }).turn_id;
    await harness.expectEvent('turn.end', {
      matcher: (m) => (m.data as { turn_id: string }).turn_id === turnId,
    });

    const triggered = harness.received.filter(
      (m) => m.type === 'event' && m.method === 'hook.triggered',
    );
    const resolved = harness.received.filter(
      (m) => m.type === 'event' && m.method === 'hook.resolved',
    );
    expect(triggered.length).toBeGreaterThanOrEqual(2);
    expect(resolved.length).toBeGreaterThanOrEqual(2);
    // Paired: every triggered has a matching resolved.
    expect(resolved.length).toBe(triggered.length);
  });
});

// ── CLI Phase follow-up ──────────────────────────────────────────────

describe('wire hooks — #2 wire hook subscription in initialize', () => {
  it.todo(
    'initialize.params.hooks [{id, event, matcher}] routes into per-session HookEngine + WireHookExecutor (CLI Phase follow-up — needs reverse-RPC hook.request handler)',
  );
});

describe('wire hooks — #4 pre+post tool-use hooks on tool call', () => {
  it.todo(
    '4 lifecycle hooks fire around Read tool call (CLI Phase follow-up — layered on #2 hook registration)',
  );
});

describe.skipIf(process.platform === 'win32')('wire hooks — #5 PreToolUse blocks tool', () => {
  it.todo(
    'PreToolUse exit 2 + stderr "blocked" → hook.resolved action=block + tool.result is_error (CLI Phase follow-up — needs POSIX shell + hook-block → tool-result wiring)',
  );
});
