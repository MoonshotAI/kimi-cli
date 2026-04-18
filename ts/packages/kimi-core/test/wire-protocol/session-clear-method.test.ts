/**
 * Slice 20-A — wire method `session.clear` routing.
 *
 * Parallels Phase 18 A.4 (`session.setPlanMode`) in spirit: pin the
 * method name in the `ManagementMethod` union, route it through
 * `managed.sessionControl.clear()`, and observe the side effect via
 * `managed.contextState.getHistory()`.
 *
 * Red-bar drivers:
 *   - `session.clear` must appear in `WireMethod` union (types.ts).
 *   - default-handlers must register a management-channel handler for it
 *     that delegates to SessionControl.clear and returns `{ok: true}`.
 *   - After the call, the session's contextState must have an empty
 *     history (driven through the in-process delegate, not through
 *     replay).
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildInitializeRequest,
  buildPromptRequest,
  buildSessionCreateRequest,
  createTestApproval,
  createWireE2EHarness,
  FakeKosongAdapter,
  type WireE2EInMemoryHarness,
} from '../helpers/index.js';
import type {
  WireMessage,
  WireMethod,
} from '../../src/wire-protocol/types.js';

// ── Boot helper ──────────────────────────────────────────────────────────

let harness: WireE2EInMemoryHarness | undefined;

async function boot(): Promise<{ sessionId: string }> {
  const approval = createTestApproval({ yolo: true });
  harness = await createWireE2EHarness({ approval });

  const init = buildInitializeRequest();
  await harness.send(init);
  await harness.collectUntilResponse(init.id);

  const create = buildSessionCreateRequest({ model: 'test-model' });
  await harness.send(create);
  const { response } = await harness.collectUntilResponse(create.id);
  const sessionId = (response.data as { session_id: string }).session_id;
  return { sessionId };
}

async function requestOn(
  method: string,
  sessionId: string,
  data: unknown,
): Promise<WireMessage> {
  if (harness === undefined) throw new Error('harness not booted');
  return harness.request(method, data, { sessionId });
}

afterEach(async () => {
  if (harness !== undefined) {
    await harness.dispose();
    harness = undefined;
  }
});

// ── 1. Method registration + routing ─────────────────────────────────────

describe('wire method session.clear — registration and routing', () => {
  it('session.clear is a WireMethod literal', () => {
    // Compile-time assertion: if `session.clear` is missing from
    // `ManagementMethod` / `WireMethod`, this fails typecheck.
    const method: WireMethod = 'session.clear';
    expect(method).toBe('session.clear');
  });

  it('returns {ok: true} with no error', async () => {
    const { sessionId } = await boot();

    const resp = await requestOn('session.clear', sessionId, {});

    expect(resp.error).toBeUndefined();
    expect(resp.data).toEqual({ ok: true });
  });

  it('is a no-op-friendly call: passes when history is already empty', async () => {
    const { sessionId } = await boot();

    const resp = await requestOn('session.clear', sessionId, {});
    expect(resp.error).toBeUndefined();

    // Second call must also succeed (idempotency at the wire layer).
    const resp2 = await requestOn('session.clear', sessionId, {});
    expect(resp2.error).toBeUndefined();
  });
});

// ── 2. Side effect — session context is cleared ──────────────────────────

describe('wire method session.clear — clears session context', () => {
  it('after prompt + clear, contextState.getHistory() is empty', async () => {
    const kosong = new FakeKosongAdapter().script({
      text: 'hello there',
      stopReason: 'end_turn',
    });
    const approval = createTestApproval({ yolo: true });
    harness = await createWireE2EHarness({ kosong, approval });

    const init = buildInitializeRequest();
    await harness.send(init);
    await harness.collectUntilResponse(init.id);

    const create = buildSessionCreateRequest({ model: 'test-model' });
    await harness.send(create);
    const { response } = await harness.collectUntilResponse(create.id);
    const sessionId = (response.data as { session_id: string }).session_id;

    const promptReq = buildPromptRequest({ sessionId, text: 'hi' });
    await harness.send(promptReq);
    await harness.collectUntilResponse(promptReq.id);

    const managedBefore = harness.sessionManager.get(sessionId) as
      | { contextState?: { getHistory(): readonly unknown[] } }
      | undefined;
    expect((managedBefore?.contextState?.getHistory() ?? []).length).toBeGreaterThan(0);

    const clearResp = await requestOn('session.clear', sessionId, {});
    expect(clearResp.error).toBeUndefined();

    const managedAfter = harness.sessionManager.get(sessionId) as
      | { contextState?: { getHistory(): readonly unknown[] } }
      | undefined;
    expect(managedAfter?.contextState?.getHistory() ?? []).toHaveLength(0);
  });
});
