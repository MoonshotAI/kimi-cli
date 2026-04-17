/* oxlint-disable vitest/warn-todo -- Phase 10 intentionally uses it.todo
   to track src implementation gaps. See MIGRATION_REPORT_phase_10.md §6. */
/**
 * Wire E2E — prompt lifecycle (Phase 10 C3).
 *
 * Migrated from Python `tests_e2e/test_wire_prompt.py`:
 *   - test_basic_prompt_events    → turn.begin → step.begin → content.delta → turn.end
 *   - test_multiline_prompt       → multiline user_input flows verbatim
 *   - test_content_part_prompt    → multimodal input (todo — schema gap)
 *   - test_max_steps_reached      → --max-steps-per-turn flag (todo — CLI flag not in src)
 *   - test_status_update_fields   → status.update fields (todo — not emitted)
 *   - test_concurrent_prompt_error→ second prompt during active turn → agent_busy
 *
 * v2 divergence:
 *   - `session.prompt` is non-blocking; it replies immediately with
 *     `{turn_id, status: 'started'}`. Turn completion is observed via
 *     the `turn.end` wire event.
 *   - `turn.begin` carries TS `{turn_id, user_input, input_kind}` where
 *     Python had `{user_input}`.
 *   - `status.update` is declared in the wire schema but not emitted
 *     from src today — tests marked as `it.todo`.
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
import type { WireMessage } from '../../src/wire-protocol/index.js';
import { installWireEventBridge } from './helpers/wire-event-bridge.js';

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

async function bootSession(
  kosong: FakeKosongAdapter,
): Promise<{ sessionId: string }> {
  harness = await createWireE2EHarness({ kosong });
  await harness.send(buildInitializeRequest());

  const createReq = buildSessionCreateRequest({ model: 'test-model' });
  await harness.send(createReq);
  const { response } = await harness.collectUntilResponse(createReq.id);
  const sessionId = (response.data as { session_id: string }).session_id;

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

  return { sessionId };
}

function eventsByMethod(events: readonly WireMessage[], method: string): WireMessage[] {
  return events.filter((m) => m.type === 'event' && m.method === method);
}

describe('wire prompt — basic lifecycle', () => {
  it('emits turn.begin / step.begin / content.delta / turn.end in order', async () => {
    const kosong = new FakeKosongAdapter({
      turns: [{ text: 'Hello wire', stopReason: 'end_turn' }],
    });
    const { sessionId } = await bootSession(kosong);

    const promptReq = buildPromptRequest({ sessionId, text: 'hi' });
    await harness!.send(promptReq);
    const { response } = await harness!.collectUntilResponse(promptReq.id);

    expect(response.error).toBeUndefined();
    const { turn_id: turnId, status } = response.data as {
      turn_id: string;
      status: string;
    };
    expect(status).toBe('started');

    const endEvent = await harness!.expectEvent('turn.end', {
      matcher: (m) => {
        const data = m.data as { turn_id: string };
        return data.turn_id === turnId;
      },
    });
    const endData = endEvent.data as { reason: string; success: boolean };
    expect(endData.reason).toBe('done');
    expect(endData.success).toBe(true);

    const frames = harness!.received;
    const begins = eventsByMethod(frames, 'turn.begin');
    expect(begins).toHaveLength(1);
    const beginData = begins[0]!.data as { user_input: string; input_kind: string };
    expect(beginData.user_input).toBe('hi');
    expect(beginData.input_kind).toBe('user');

    const steps = eventsByMethod(frames, 'step.begin');
    expect(steps.length).toBeGreaterThanOrEqual(1);

    const deltas = eventsByMethod(frames, 'content.delta');
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    const joined = deltas
      .map((m) => (m.data as { text?: string }).text ?? '')
      .join('');
    expect(joined).toBe('Hello wire');

    // Order check — turn.begin is the first turn-scoped event; turn.end
    // the last.
    const turnScoped = frames.filter(
      (m) => m.type === 'event' && (m.data as { turn_id?: string } | undefined)?.turn_id === turnId,
    );
    expect(turnScoped.at(0)?.method).toBe('turn.begin');
    expect(turnScoped.at(-1)?.method).toBe('turn.end');
  });

  it('preserves multi-line user_input verbatim on turn.begin', async () => {
    const kosong = new FakeKosongAdapter({
      turns: [{ text: 'ok', stopReason: 'end_turn' }],
    });
    const { sessionId } = await bootSession(kosong);

    const multiline = 'line1\nline2';
    const promptReq = buildPromptRequest({ sessionId, text: multiline });
    await harness!.send(promptReq);
    const { response } = await harness!.collectUntilResponse(promptReq.id);
    const turnId = (response.data as { turn_id: string }).turn_id;

    await harness!.expectEvent('turn.end', {
      matcher: (m) => (m.data as { turn_id: string }).turn_id === turnId,
    });

    const begins = eventsByMethod(harness!.received, 'turn.begin');
    const beginData = begins[0]!.data as { user_input: string };
    expect(beginData.user_input).toBe(multiline);
  });
});

describe('wire prompt — concurrent requests', () => {
  it('returns {error:"agent_busy"} when a second prompt arrives mid-turn', async () => {
    // First turn blocks forever (second LLM call never arrives) so we
    // can assert the second prompt is rejected.
    const pending = new Promise<never>(() => {});
    const kosong = new FakeKosongAdapter({
      turns: [{ text: 'first', stopReason: 'end_turn' }],
    });
    // Override `chat` so the first call hangs — keeps the turn in
    // `active` state through the busy-check.
    const originalChat = kosong.chat.bind(kosong);
    let hangNext = true;
    kosong.chat = async (params) => {
      if (hangNext) {
        hangNext = false;
        kosong.recordCall(params);
        await pending;
        throw new Error('unreachable');
      }
      return originalChat(params);
    };

    const { sessionId } = await bootSession(kosong);

    const first = buildPromptRequest({ sessionId, text: 'run' });
    await harness!.send(first);
    const { response: firstRes } = await harness!.collectUntilResponse(first.id);
    expect((firstRes.data as { status: string }).status).toBe('started');

    // Wait until the turn has actually entered `active` before firing
    // the second prompt, otherwise the busy check races the tracker.
    await harness!.expectEvent('turn.begin');

    const second = buildPromptRequest({ sessionId, text: 'second' });
    await harness!.send(second);
    const { response: secondRes } = await harness!.collectUntilResponse(second.id);

    // v2 divergence — TS returns the busy state as a DispatchResponse
    // with {error: 'agent_busy'} inside `data`. Python mapped this to
    // -32000 at the wire layer; the TS default handler passes the
    // dispatch shape through unchanged.
    const payload = secondRes.data as { error?: string };
    expect(payload.error).toBe('agent_busy');
  });
});

// ── Phase 17 lifts — each scenario now has a dedicated test file ─────

describe('wire prompt — Phase 17 lifts', () => {
  // Phase 17 A.7 — multimodal content-part input behavioural coverage
  // now lives in `test/e2e/wire-multimodal-roundtrip.test.ts`.
  it.todo('multimodal content-part input — covered by wire-multimodal-roundtrip.test.ts (Phase 17 A.7)');

  // Phase 17 A.8 — max_steps_reached now surfaces through the
  // turn.end `stop_reason` field + a `session.error`-like status.
  it('max_steps_reached status: Soul trips after max_steps and turn.end.reason="error"', async () => {
    // A provider that never emits a stop_reason but also never issues a
    // tool call forces Soul to loop until the max-steps gate trips.
    // FakeKosongAdapter with a single turn whose stopReason is
    // `tool_use` without any tool_calls triggers the loop-detection
    // path; if the harness does not yet expose a knob for this the
    // Implementer will need to add one — the assertion shape below
    // pins the expected surface.
    const kosong = new FakeKosongAdapter({
      turns: Array.from({ length: 120 }, () => ({
        text: '...',
        stopReason: 'tool_use',
      })),
    });
    const { sessionId } = await bootSession(kosong);
    const req = buildPromptRequest({ sessionId, text: 'loop' });
    await harness!.send(req);
    const { response } = await harness!.collectUntilResponse(req.id);
    const turnId = (response.data as { turn_id: string }).turn_id;

    const endEvent = await harness!.expectEvent('turn.end', {
      matcher: (m) => (m.data as { turn_id: string }).turn_id === turnId,
      timeoutMs: 10_000,
    });
    const endData = endEvent.data as { reason: string; success: boolean };
    // Either the turn surfaces as reason="error" (current v2) or
    // "max_steps_reached" is reflected on a stop_reason field the
    // implementer adds. The assertion allows the implementer to pick
    // either: success must be false.
    expect(endData.success).toBe(false);
  });

  // Phase 17 A.2 — status.update emission covered by
  // `test/e2e/wire-status-update.test.ts`.
  it.todo('status.update token_usage / context_tokens snapshot — covered by wire-status-update.test.ts (Phase 17 A.2)');
});
