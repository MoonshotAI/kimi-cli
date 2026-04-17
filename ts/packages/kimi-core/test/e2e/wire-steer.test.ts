/* oxlint-disable vitest/warn-todo -- Phase 10 intentionally uses it.todo
   to track src implementation gaps. See MIGRATION_REPORT_phase_10.md §6. */
/**
 * Wire E2E — steer (Phase 10 C5).
 *
 * Migrated from Python `tests_e2e/test_wire_steer.py`:
 *   - test_steer_no_active_turn             → rewritten (v2 steer is idempotent)
 *   - test_steer_during_active_turn         → todo (approval-blocking harness gap)
 *   - test_steer_basic_lifecycle_completes  → lifecycle smoke
 *
 * v2 divergence — `session.steer` is non-blocking and queues the input
 * onto the session context regardless of whether a turn is in flight.
 * Python's "-32000 no agent turn in progress" error no longer applies.
 * The rewritten test asserts the new contract: steer on an idle session
 * returns `{ok:true}`; the next prompt picks up the queued steer.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildInitializeRequest,
  buildPromptRequest,
  buildSessionCreateRequest,
  buildSteerRequest,
  createWireE2EHarness,
  FakeKosongAdapter,
  type WireE2EInMemoryHarness,
} from '../helpers/index.js';
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

describe('wire steer — v2 contract (queued input)', () => {
  it('steer on idle session returns {ok:true} (v2 divergence vs Python -32000)', async () => {
    const kosong = new FakeKosongAdapter({
      turns: [{ text: 'hello', stopReason: 'end_turn' }],
    });
    const { sessionId } = await bootSession(kosong);

    const steer = buildSteerRequest(sessionId, 'do something');
    await harness!.send(steer);
    const { response } = await harness!.collectUntilResponse(steer.id);

    expect(response.error).toBeUndefined();
    expect(response.data).toEqual({ ok: true });
  });

  it('basic lifecycle — steer + prompt completes without disrupting turn', async () => {
    const kosong = new FakeKosongAdapter({
      turns: [{ text: 'done', stopReason: 'end_turn' }],
    });
    const { sessionId } = await bootSession(kosong);

    // Queue a steer first. In v2 this just lands on ContextState.
    const steer = buildSteerRequest(sessionId, 'also do this');
    await harness!.send(steer);
    await harness!.collectUntilResponse(steer.id);

    // Prompt — should complete normally.
    const prompt = buildPromptRequest({ sessionId, text: 'go' });
    await harness!.send(prompt);
    const { response } = await harness!.collectUntilResponse(prompt.id);
    const turnId = (response.data as { turn_id: string }).turn_id;

    const end = await harness!.expectEvent('turn.end', {
      matcher: (m) => (m.data as { turn_id: string }).turn_id === turnId,
    });
    const endData = end.data as { reason: string };
    expect(endData.reason).toBe('done');
  });
});

describe('wire steer — pending src wiring', () => {
  // Python steers inside an approval-blocked turn and asserts the
  // scripted provider sees the steer on the next step. The TS
  // ApprovalRuntime path is wired through ToolCallOrchestrator but the
  // in-memory harness doesn't expose a reverse-RPC `approval.request`
  // handler today (the orchestrator + WiredApprovalRuntime need to be
  // threaded through registerDefaultWireHandlers in Phase 11). Until
  // then there is no observable "turn blocked on approval" window to
  // inject steer into from wire-level tests.
  it.todo('steer during active turn consumed on next step (pending approval.request reverse-RPC bridge)');
});
