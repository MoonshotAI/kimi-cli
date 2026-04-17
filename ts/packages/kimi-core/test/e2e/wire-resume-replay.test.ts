/**
 * Phase 17 A.5 — `session.resume` + `session.replay`.
 *
 * - `session.resume` default handler must be registered (v2 §3.5
 *   lists it; today harness ignores). Returns
 *   `{session_id, turn_count, last_turn_id}`.
 * - `session.replay` joins ManagementMethod union. Streams the wire
 *   history in chunks (`session.replay.chunk` reply method) with a
 *   terminating `session.replay.end` frame. Supports `from_seq` for
 *   resume-streaming.
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
import { createWireRequest } from '../../src/wire-protocol/message-factory.js';
import type { WireMessage } from '../../src/wire-protocol/index.js';
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

async function bootWithTurn(kosong: FakeKosongAdapter): Promise<{
  sessionId: string;
  turnId: string;
}> {
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

  const p = buildPromptRequest({ sessionId, text: 'hi' });
  await harness.send(p);
  const { response: startRes } = await harness.collectUntilResponse(p.id);
  const turnId = (startRes.data as { turn_id: string }).turn_id;
  await harness.expectEvent('turn.end', {
    matcher: (m) => (m.data as { turn_id: string }).turn_id === turnId,
  });
  await managed.journalWriter.flush();

  return { sessionId, turnId };
}

describe('Phase 17 A.5 — session.resume default handler', () => {
  it('returns {session_id, turn_count, last_turn_id} for an existing session', async () => {
    const kosong = new FakeKosongAdapter({ turns: [{ text: 'ok' }] });
    const { sessionId, turnId } = await bootWithTurn(kosong);

    const resumeReq = createWireRequest({
      method: 'session.resume',
      sessionId,
      data: {},
    });
    await harness!.send(resumeReq);
    const { response } = await harness!.collectUntilResponse(resumeReq.id);
    expect(response.error).toBeUndefined();
    const data = response.data as {
      session_id: string;
      turn_count: number;
      last_turn_id?: string;
    };
    expect(data.session_id).toBe(sessionId);
    expect(data.turn_count).toBeGreaterThanOrEqual(1);
    expect(data.last_turn_id).toBe(turnId);
  });
});

describe('Phase 17 A.5 — session.replay streams wire history', () => {
  it('replays the full wire.jsonl as chunked replies + terminating end frame', async () => {
    const kosong = new FakeKosongAdapter({ turns: [{ text: 'hello' }] });
    const { sessionId } = await bootWithTurn(kosong);

    const replayReq = createWireRequest({
      method: 'session.replay',
      sessionId,
      data: {},
    });

    // Collect frames addressed to this replay request.
    const chunks: WireMessage[] = [];
    let sawEnd = false;
    const unsubscribe = harness!.queue.subscribe((m) => {
      if (m.request_id !== replayReq.id) return;
      if (m.method === 'session.replay.chunk') chunks.push(m);
      if (m.method === 'session.replay.end') sawEnd = true;
    });
    try {
      await harness!.send(replayReq);
      // Wait up to 5s for the end frame.
      const deadline = Date.now() + 5_000;
      while (!sawEnd && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      unsubscribe();
    }

    expect(sawEnd).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
    // Each chunk carries a `records` array of wire records from
    // wire.jsonl.
    const firstChunk = chunks[0]!.data as { records: readonly { type: string }[] };
    expect(Array.isArray(firstChunk.records)).toBe(true);
  });

  it('supports from_seq to resume streaming partway through', async () => {
    const kosong = new FakeKosongAdapter({ turns: [{ text: 'hello' }] });
    const { sessionId } = await bootWithTurn(kosong);

    // First replay — fully consume so we know how many records exist.
    const firstReq = createWireRequest({
      method: 'session.replay',
      sessionId,
      data: {},
    });
    const firstRecords: Array<{ seq?: number }> = [];
    let firstEnd = false;
    const unsub1 = harness!.queue.subscribe((m) => {
      if (m.request_id !== firstReq.id) return;
      if (m.method === 'session.replay.chunk') {
        const recs = (m.data as { records: Array<{ seq?: number }> }).records;
        firstRecords.push(...recs);
      }
      if (m.method === 'session.replay.end') firstEnd = true;
    });
    await harness!.send(firstReq);
    const deadline1 = Date.now() + 5_000;
    while (!firstEnd && Date.now() < deadline1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    unsub1();
    expect(firstRecords.length).toBeGreaterThan(1);

    // Now request replay with from_seq midway — must skip earlier records.
    const midSeq = firstRecords[1]!.seq ?? 1;
    const secondReq = createWireRequest({
      method: 'session.replay',
      sessionId,
      data: { from_seq: midSeq },
    });
    const secondRecords: Array<{ seq?: number }> = [];
    let secondEnd = false;
    const unsub2 = harness!.queue.subscribe((m) => {
      if (m.request_id !== secondReq.id) return;
      if (m.method === 'session.replay.chunk') {
        const recs = (m.data as { records: Array<{ seq?: number }> }).records;
        secondRecords.push(...recs);
      }
      if (m.method === 'session.replay.end') secondEnd = true;
    });
    await harness!.send(secondReq);
    const deadline2 = Date.now() + 5_000;
    while (!secondEnd && Date.now() < deadline2) {
      await new Promise((r) => setTimeout(r, 20));
    }
    unsub2();

    expect(secondRecords.length).toBeLessThan(firstRecords.length);
    // All records returned must have seq >= midSeq.
    for (const r of secondRecords) {
      if (r.seq !== undefined) {
        expect(r.seq).toBeGreaterThanOrEqual(midSeq);
      }
    }
  });
});
