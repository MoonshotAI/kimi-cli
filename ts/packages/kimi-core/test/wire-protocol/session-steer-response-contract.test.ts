/**
 * Phase 17 E.2 — `SessionSteerResponseData` type-implementation contract.
 *
 * Original `types.ts:283-285` declared `{queued: true}`; the runtime
 * actually returns `{ok: true}` via DispatchResponse. E.2 aligns type
 * with runtime (drops `queued` in favour of `ok`).
 *
 * Assertions:
 *   - Type-level: `SessionSteerResponseData` is `{ok: true}`.
 *   - Runtime-level: harness round-trip of `session.steer` returns
 *     `data: { ok: true }`.
 */

import { afterEach, describe, expect, it, expectTypeOf } from 'vitest';

import type { SessionSteerResponseData } from '../../src/wire-protocol/types.js';
import {
  buildInitializeRequest,
  buildPromptRequest,
  buildSessionCreateRequest,
  createWireE2EHarness,
  FakeKosongAdapter,
  type WireE2EInMemoryHarness,
} from '../helpers/index.js';
import { createWireRequest } from '../../src/wire-protocol/message-factory.js';

let harness: WireE2EInMemoryHarness | undefined;

afterEach(async () => {
  if (harness !== undefined) {
    await harness.dispose();
    harness = undefined;
  }
});

describe('Phase 17 E.2 — SessionSteerResponseData contract', () => {
  it('type: SessionSteerResponseData = {ok: true}', () => {
    expectTypeOf<SessionSteerResponseData>().toEqualTypeOf<{ ok: true }>();
  });

  it('runtime: session.steer round-trip returns data:{ok:true}', async () => {
    // Hang the first turn so steer is accepted (steer-during-idle is
    // a separate codepath; we want the active-turn variant to match
    // DispatchResponse).
    const pending = new Promise<never>(() => {});
    const kosong = new FakeKosongAdapter({
      turns: [{ text: 'unused', stopReason: 'end_turn' }],
    });
    let hangNext = true;
    const originalChat = kosong.chat.bind(kosong);
    kosong.chat = async (params) => {
      if (hangNext) {
        hangNext = false;
        kosong.recordCall(params);
        await pending;
        throw new Error('unreachable');
      }
      return originalChat(params);
    };

    harness = await createWireE2EHarness({ kosong });
    await harness.send(buildInitializeRequest());
    const cReq = buildSessionCreateRequest({ model: 'test-model' });
    await harness.send(cReq);
    const { response: cRes } = await harness.collectUntilResponse(cReq.id);
    const sessionId = (cRes.data as { session_id: string }).session_id;

    // Kick off a prompt so there's an active turn to steer.
    const pReq = buildPromptRequest({ sessionId, text: 'run' });
    await harness.send(pReq);
    await harness.collectUntilResponse(pReq.id);

    // Now send session.steer.
    const steerReq = createWireRequest({
      method: 'session.steer',
      sessionId,
      data: { input: 'stop and reconsider' },
    });
    await harness.send(steerReq);
    const { response } = await harness.collectUntilResponse(steerReq.id);
    expect(response.error).toBeUndefined();
    expect(response.data).toMatchObject({ ok: true });
  });
});
