/**
 * Phase 17 A.2 — `status.update` real-emission coverage.
 *
 * `StatusUpdateEventData` (wire-protocol/types.ts:390) is declared but
 * nothing emits it today. A.2 固化决策 wires the following emit sites:
 *
 *   1. TurnManager.onTurnEnd — one snapshot per turn (token + context usage)
 *   2. ContextState.setPlanMode — on plan-mode flip (plan_mode field)
 *   3. Session resume completion — initial snapshot including model
 *
 * All three flow through the A.1 WireEventBridge `status` channel.
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
import { createWireRequest } from '../../src/wire-protocol/message-factory.js';
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

function statusUpdates(frames: readonly WireMessage[]): WireMessage[] {
  return frames.filter((f) => f.type === 'event' && f.method === 'status.update');
}

describe('Phase 17 A.2 — status.update emission', () => {
  it('turn.end emits a status.update snapshot with token_usage + context_usage', async () => {
    const kosong = new FakeKosongAdapter({
      turns: [{ text: 'ok', stopReason: 'end_turn' }],
    });
    const { sessionId } = await bootSession(kosong);

    const req = buildPromptRequest({ sessionId, text: 'hi' });
    await harness!.send(req);
    const { response } = await harness!.collectUntilResponse(req.id);
    const turnId = (response.data as { turn_id: string }).turn_id;
    await harness!.expectEvent('turn.end', {
      matcher: (m) => (m.data as { turn_id: string }).turn_id === turnId,
    });

    const updates = statusUpdates(harness!.received);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    // The last update for this turn must carry usage fields.
    const last = updates.at(-1)!;
    const data = last.data as {
      token_usage?: unknown;
      context_usage?: unknown;
      model?: string;
    };
    expect(data.token_usage).toBeDefined();
    expect(data.context_usage).toBeDefined();
  });

  it('session.setPlanMode triggers a status.update with plan_mode', async () => {
    const kosong = new FakeKosongAdapter({
      turns: [{ text: 'ok', stopReason: 'end_turn' }],
    });
    const { sessionId } = await bootSession(kosong);

    const planReq = createWireRequest({
      method: 'session.setPlanMode',
      sessionId,
      data: { enabled: true },
    });
    await harness!.send(planReq);
    await harness!.collectUntilResponse(planReq.id);

    await harness!.expectEvent('status.update', {
      matcher: (m) => (m.data as { plan_mode?: boolean }).plan_mode === true,
    });
  });

  it('session.resume emits an initial status.update snapshot (including model)', async () => {
    // Boot the session, run a turn so there is wire history, then
    // resume through the wire surface — the new handler must announce
    // the session's state via status.update.
    const kosong = new FakeKosongAdapter({
      turns: [
        { text: 'first', stopReason: 'end_turn' },
        { text: 'second', stopReason: 'end_turn' },
      ],
    });
    const { sessionId } = await bootSession(kosong);

    // First turn to populate wire.jsonl.
    const p = buildPromptRequest({ sessionId, text: 'hi' });
    await harness!.send(p);
    const { response: startRes } = await harness!.collectUntilResponse(p.id);
    const turnId = (startRes.data as { turn_id: string }).turn_id;
    await harness!.expectEvent('turn.end', {
      matcher: (m) => (m.data as { turn_id: string }).turn_id === turnId,
    });

    // Now call session.resume — this exercises A.5 routing but A.2
    // expects a status.update snapshot right after.
    const resumeReq = createWireRequest({
      method: 'session.resume',
      sessionId,
      data: {},
    });
    const beforeCount = statusUpdates(harness!.received).length;
    await harness!.send(resumeReq);
    await harness!.collectUntilResponse(resumeReq.id);

    await harness!.expectEvent('status.update', {
      matcher: (m) => {
        const d = m.data as { model?: string };
        return typeof d.model === 'string' && d.model.length > 0;
      },
    });
    expect(statusUpdates(harness!.received).length).toBeGreaterThan(beforeCount);
  });
});
