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
import { PROCESS_SESSION_ID } from '../../src/wire-protocol/types.js';
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

describe('wire errors — not yet wired in src', () => {
  // -32700 Invalid JSON — `WireCodec.decode` throws MalformedWireFrameError
  // which is swallowed by the in-memory harness's server.onMessage (no
  // way to construct a valid request_id back). Unit coverage sits in
  // `test/wire-protocol/codec-edge-cases.test.ts`. A real stdio harness
  // will surface this as -32700 when Phase 11 wires the outer dispatcher.
  it.todo('-32700: malformed JSON yields Invalid JSON format (pending Phase 11 stdio handler)');

  // -32600 Invalid Request — TS `WireMessageSchema` rejects the envelope
  // entirely, so no request_id exists to reply to. Same swallow path as
  // -32700 — unit coverage already lives in codec-edge-cases.test.ts.
  it.todo('-32600: invalid envelope yields Invalid request (pending Phase 11 stdio handler)');

  // -32602 Invalid params — src `session.prompt` handler does not zod-
  // validate `SessionPromptRequestData`. Today an undefined `input` slips
  // through to `context.appendUserMessage({text:undefined})`. Phase 11
  // should route param-validation failures to -32602.
  it.todo('-32602: session.prompt missing input yields Invalid parameters (pending Phase 11 param validation)');

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
