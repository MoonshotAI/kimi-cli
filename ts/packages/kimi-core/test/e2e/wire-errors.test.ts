/* oxlint-disable vitest/warn-todo -- Phase 10 intentionally uses it.todo
   to track src implementation gaps. See MIGRATION_REPORT_phase_10.md §6. */
/**
 * Wire E2E — JSON-RPC error code coverage (Phase 10 C2).
 *
 * Migrated from Python `tests_e2e/test_wire_errors.py` — 8 error codes
 * span -32700 / -32600 / -32601 / -32602 / -32000 / -32001 / -32002 /
 * -32003. TS divergence from Python:
 *
 *   - Codec-level failures (-32700 malformed JSON, -32600 invalid
 *     envelope) are SWALLOWED by the in-memory harness — mirrors the
 *     Python stdio transport behaviour of "never reply to a frame we
 *     cannot address". Tested separately through unit tests on
 *     `WireCodec.decode` (`codec-edge-cases.test.ts`). Left as `it.todo`
 *     here until a stdio harness lands in Phase 11.
 *   - LLM-level errors (-32001 LLM not set, -32002 capability mismatch,
 *     -32003 provider DSL error) are not plumbed into the wire error
 *     channel yet. Tracked as `it.todo` pending Phase 11 LLM-error
 *     wiring.
 *   - `session.cancel` on an idle turn returns `{ok:true}` in TS v2 rather
 *     than -32000 (the v2 contract simplifies cancel into an idempotent
 *     noop). The -32000 case is re-scoped to "cancel on unknown
 *     session" which does exercise the router's session-not-found path.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createWireRequest } from '../../src/wire-protocol/message-factory.js';
import { PROCESS_SESSION_ID, type WireMessage } from '../../src/wire-protocol/types.js';
import {
  buildCancelRequest,
  buildInitializeRequest,
  buildPromptRequest,
  buildSessionCreateRequest,
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

async function makeSession(): Promise<string> {
  harness = await createWireE2EHarness({
    kosongOptions: { turns: [{ text: 'ok' }] },
  });
  await harness.send(buildInitializeRequest());
  const createReq = buildSessionCreateRequest({ model: 'test-model' });
  await harness.send(createReq);
  const { response } = await harness.collectUntilResponse(createReq.id);
  return (response.data as { session_id: string }).session_id;
}

describe('wire errors — routing layer', () => {
  it('-32601: unknown process method returns Method not found', async () => {
    harness = await createWireE2EHarness();
    const req = createWireRequest({ method: 'nope.method', sessionId: PROCESS_SESSION_ID });
    await harness.send(req);
    const { response } = await harness.collectUntilResponse(req.id);

    expect(response.error?.code).toBe(-32601);
    expect(response.error?.message).toMatch(/method not found/i);
  });

  it('-32000: cancel on unknown session id returns Session not found', async () => {
    harness = await createWireE2EHarness();
    const req = buildCancelRequest('ses_does_not_exist');
    await harness.send(req);
    const { response } = await harness.collectUntilResponse(req.id);

    expect(response.error?.code).toBe(-32000);
    expect(response.error?.message).toMatch(/session not found/i);
  });

  it('-32000: session.prompt on unknown session id returns Session not found', async () => {
    harness = await createWireE2EHarness();
    const req = buildPromptRequest({ sessionId: 'ses_ghost', text: 'hi' });
    await harness.send(req);
    const { response } = await harness.collectUntilResponse(req.id);

    expect(response.error?.code).toBe(-32000);
    expect(response.error?.message).toMatch(/session not found/i);
  });

  it('unknown method on a valid session falls through to -32601', async () => {
    const sessionId = await makeSession();
    const req = createWireRequest({ method: 'session.notAThing', sessionId });
    await harness!.send(req);
    const { response } = await harness!.collectUntilResponse(req.id);

    expect(response.error?.code).toBe(-32601);
    expect(response.error?.message).toMatch(/method not found/i);
  });
});

describe('wire errors — Phase 17 A.4 (error-mapping central table)', () => {
  // Phase 17 A.4 — mapToWireError now runs in both the production
  // `runWire` frame loop and the in-memory harness's server.onMessage.
  // Each of these lifts the original Phase 10 `it.todo` into an
  // executable assertion; implementer lands
  // `src/wire-protocol/error-mapping.ts` + harness wiring so these
  // flip from red to green.
  it('-32700: malformed JSON yields Parse error response (request_id: null)', async () => {
    harness = await createWireE2EHarness();
    // Send a raw non-JSON frame through the underlying transport to
    // force a codec-level failure. The harness must emit a -32700
    // response rather than silently swallow.
    const malformed = 'not-a-json-frame';
    const errorFrame = await new Promise<WireMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 2_000);
      const original = harness!.queue.subscribe((msg) => {
        if (msg.type === 'response' && msg.error !== undefined) {
          clearTimeout(timer);
          original();
          resolve(msg);
        }
      });
      void harness!.client.send(malformed);
    });
    expect(errorFrame.error?.code).toBe(-32700);
    expect(errorFrame.error?.message.toLowerCase()).toMatch(/parse|json/);
    expect(errorFrame.request_id).toBeUndefined();
  });

  it('-32600: invalid envelope (missing required fields) yields Invalid request', async () => {
    harness = await createWireE2EHarness();
    // Ship a syntactically valid JSON frame that fails
    // `WireMessageSchema` (missing `type`).
    const bad = JSON.stringify({
      id: 'req_bad',
      time: Date.now(),
      session_id: PROCESS_SESSION_ID,
      from: 'client',
      to: 'server',
      method: 'initialize',
    });
    const errorFrame = await new Promise<WireMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 2_000);
      const unsub = harness!.queue.subscribe((msg) => {
        if (msg.type === 'response' && msg.error !== undefined) {
          clearTimeout(timer);
          unsub();
          resolve(msg);
        }
      });
      void harness!.client.send(bad);
    });
    expect(errorFrame.error?.code).toBe(-32600);
  });

  it('-32602: session.prompt with non-string input yields Invalid params', async () => {
    const sessionId = await makeSession();
    // Craft a session.prompt request whose `input` is a number —
    // fails the widened `SessionPromptRequestData` schema
    // (string | UserInputPart[]).
    const req = createWireRequest({
      method: 'session.prompt',
      sessionId,
      data: { input: 42 },
    });
    await harness!.send(req);
    const { response } = await harness!.collectUntilResponse(req.id);
    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message.toLowerCase()).toMatch(/invalid\s*params/);
  });

  // -32000 cancel without in-flight turn — v2 TurnManager returns
  // `{ok:true}` (idempotent). Deliberate divergence: Python treated
  // cancel-when-idle as an error; v2 treats it as a no-op so UI code can
  // safely fire-and-forget cancels.
  it.todo('cancel-when-idle: v2 returns {ok:true} (Python returned -32000; deliberate divergence — see migration report §二 Rewritten)');

  // -32001 LLM not set — config-layer concern; the in-memory harness
  // always injects a FakeKosongAdapter so there is no path to exercise
  // this. Will surface once the production `--wire` binary wires config
  // loading through to wire errors in Phase 11.
  it.todo('-32001: LLM not set (pending Phase 11 config-layer wire-error plumbing)');

  // -32002 LLM capability mismatch — depends on src modelling capabilities
  // and rejecting multimodal inputs against the active model. Not wired
  // in src today.
  it.todo('-32002: LLM does not support required capability (pending Phase 11 capability gate)');

  // -32003 provider error — scripted-echo DSL parse failure should
  // bubble up as -32003. FakeKosongAdapter errors today surface as
  // plain thrown errors inside the turn, not translated to wire errors.
  it.todo('-32003: provider DSL error (pending Phase 11 provider-error → wire-error bridge)');
});
