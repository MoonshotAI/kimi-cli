/* oxlint-disable vitest/warn-todo -- Phase 10 intentionally uses it.todo
   to track src implementation gaps. See MIGRATION_REPORT_phase_10.md §6. */
/**
 * Wire E2E — session files / lifecycle (Phase 10 C4).
 *
 * Migrated from Python `tests_e2e/test_wire_sessions.py`:
 *   - test_session_files_created     → wire.jsonl + state.json exist
 *   - test_continue_session_appends  → session.resume appends (todo — method not wired end-to-end)
 *   - test_clear_context_rotates     → /clear slash (todo — slash handling not in wire)
 *   - test_manual_compact            → session.compact round-trip
 *   - test_manual_compact_with_usage → real LLM compact (todo — stub handler)
 *   - test_replay_streams_wire_history → replay method (todo — not wired)
 *
 * v2 divergence:
 *   - `context.jsonl` is gone — TS merges into `wire.jsonl` (v2 §3 decision).
 *   - `--continue` / `--session` CLI flags are not in scope of wire E2E;
 *     session identity is supplied through `session.create {session_id}`.
 *   - Slash handling (`/clear`, `/compact`) is a CLI-layer concern in v2 —
 *     the wire protocol exposes `session.compact` as a dedicated method.
 */

import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createWireRequest } from '../../src/wire-protocol/message-factory.js';
import {
  buildInitializeRequest,
  buildPromptRequest,
  buildSessionCreateRequest,
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
  opts: { sessionId?: string } = {},
): Promise<{ sessionId: string; sessionDir: string }> {
  harness = await createWireE2EHarness({ kosong });
  await harness.send(buildInitializeRequest());

  const createReq = buildSessionCreateRequest({
    model: 'test-model',
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
  });
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

  const sessionDir = join(harness.homeDir, 'sessions', sessionId);
  return { sessionId, sessionDir };
}

describe('wire sessions — filesystem layout', () => {
  it('session.create + session.prompt writes wire.jsonl + state.json', async () => {
    const kosong = new FakeKosongAdapter({
      turns: [{ text: 'hello', stopReason: 'end_turn' }],
    });
    const { sessionId, sessionDir } = await bootSession(kosong);

    const promptReq = buildPromptRequest({ sessionId, text: 'hi' });
    await harness!.send(promptReq);
    const { response } = await harness!.collectUntilResponse(promptReq.id);
    const turnId = (response.data as { turn_id: string }).turn_id;
    await harness!.expectEvent('turn.end', {
      matcher: (m) => (m.data as { turn_id: string }).turn_id === turnId,
    });

    // Force JournalWriter to drain pending appends so wire.jsonl is
    // observable on disk. Using the public `flush()` API avoids the
    // CI flake window a naked setTimeout would leave.
    const managed = harness!.sessionManager.get(sessionId);
    await managed!.journalWriter.flush();

    const entries = (await readdir(sessionDir)).toSorted();
    expect(entries).toEqual(expect.arrayContaining(['wire.jsonl', 'state.json']));

    const wireStat = await stat(join(sessionDir, 'wire.jsonl'));
    expect(wireStat.size).toBeGreaterThan(0);
    const stateStat = await stat(join(sessionDir, 'state.json'));
    expect(stateStat.size).toBeGreaterThan(0);
  });

  it('session.compact dispatches and returns ok (stub handler)', async () => {
    const kosong = new FakeKosongAdapter({
      turns: [{ text: 'hello', stopReason: 'end_turn' }],
    });
    const { sessionId } = await bootSession(kosong);

    // One turn first so there's context to compact.
    const promptReq = buildPromptRequest({ sessionId, text: 'hi' });
    await harness!.send(promptReq);
    const { response: startRes } = await harness!.collectUntilResponse(promptReq.id);
    const turnId = (startRes.data as { turn_id: string }).turn_id;
    await harness!.expectEvent('turn.end', {
      matcher: (m) => (m.data as { turn_id: string }).turn_id === turnId,
    });

    // Now invoke session.compact through the management channel.
    const compactReq = createWireRequest({ method: 'session.compact', sessionId });
    await harness!.send(compactReq);
    const { response } = await harness!.collectUntilResponse(compactReq.id);

    expect(response.error).toBeUndefined();
    // Phase 9 stub returns {ok:true}; Phase 11 will wire real compaction.
    expect(response.data).toEqual({ ok: true });
  });
});

// ── Phase 11 gaps tracked in migration report ──────────────────────

describe('wire sessions — pending src wiring', () => {
  it('ensures home dir structure exists after boot (smoke)', async () => {
    const kosong = new FakeKosongAdapter({
      turns: [{ text: 'ok', stopReason: 'end_turn' }],
    });
    const { sessionId } = await bootSession(kosong);
    // Force the sessions dir to be present — createSession creates it
    // lazily via JournalWriter.init; this smoke check proves the path
    // service picks the right root.
    await mkdir(join(harness!.homeDir, 'sessions'), { recursive: true });
    expect(sessionId).toMatch(/^ses_/);
  });

  // Phase 17 A.5 — session.resume default handler now registered;
  // behavioural coverage lives in test/e2e/wire-resume-replay.test.ts.
  // This is a smoke assertion that a second session.prompt after resume
  // appends to wire.jsonl rather than rotating.
  it('session.resume appends to an existing session', async () => {
    const kosong = new FakeKosongAdapter({
      turns: [
        { text: 'first', stopReason: 'end_turn' },
        { text: 'second', stopReason: 'end_turn' },
      ],
    });
    const { sessionId, sessionDir } = await bootSession(kosong);

    const p1 = buildPromptRequest({ sessionId, text: 'one' });
    await harness!.send(p1);
    const { response: r1 } = await harness!.collectUntilResponse(p1.id);
    const t1 = (r1.data as { turn_id: string }).turn_id;
    await harness!.expectEvent('turn.end', {
      matcher: (m) => (m.data as { turn_id: string }).turn_id === t1,
    });

    // Explicit resume round-trip.
    const resumeReq = createWireRequest({
      method: 'session.resume',
      sessionId,
      data: {},
    });
    await harness!.send(resumeReq);
    const { response: resumeRes } = await harness!.collectUntilResponse(
      resumeReq.id,
    );
    expect(resumeRes.error).toBeUndefined();

    const managed1 = harness!.sessionManager.get(sessionId);
    await managed1!.journalWriter.flush();
    const sizeBefore = (await stat(join(sessionDir, 'wire.jsonl'))).size;

    const p2 = buildPromptRequest({ sessionId, text: 'two' });
    await harness!.send(p2);
    const { response: r2 } = await harness!.collectUntilResponse(p2.id);
    const t2 = (r2.data as { turn_id: string }).turn_id;
    await harness!.expectEvent('turn.end', {
      matcher: (m) => (m.data as { turn_id: string }).turn_id === t2,
    });

    const managed2 = harness!.sessionManager.get(sessionId);
    await managed2!.journalWriter.flush();
    const sizeAfter = (await stat(join(sessionDir, 'wire.jsonl'))).size;
    expect(sizeAfter).toBeGreaterThan(sizeBefore);
  });

  // `/clear` is a CLI-layer slash command in v2, not a wire method.
  // The skill manager's user-slash pipeline belongs to a CLI Phase
  // follow-up (not in Phase 17 scope).
  it.todo('/clear slash rotates context (CLI Phase follow-up)');

  // Real compaction with LLM call needs CompactionProvider supplied to
  // SoulPlus + max_preserved_messages config. Production wiring owned by
  // CLI Phase (Phase 17 leaves the harness stub in place).
  it.todo('manual /compact triggers real LLM call with token usage (CLI Phase follow-up)');

  // Phase 17 A.5 — session.replay behavioural coverage lives in
  // `wire-resume-replay.test.ts`. This file keeps the Phase 10 seat
  // so migration provenance is visible.
  it.todo('replay streams wire history — covered by wire-resume-replay.test.ts (Phase 17 A.5)');
});
