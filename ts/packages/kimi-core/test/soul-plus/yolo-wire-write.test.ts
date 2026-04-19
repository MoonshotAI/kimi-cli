/**
 * Phase 24 — 24a contract: wire record for permission_mode_changed.
 *
 * Architecture (Phase 24 RR1 B-1 fix):
 *   - DefaultSessionControl.setYolo() is the sole writer of the
 *     permission_mode_changed wire record (idempotent + journal-aware).
 *   - The session.setYolo wire handler calls BOTH store.setYolo()
 *     (state.json persistence) AND sessionControl.setYolo() (wire record).
 *   - The soul-plus.ts onChanged listener ONLY flips TurnManager.permissionMode
 *     live; it does NOT write any wire record (avoids async-listener safety issues).
 *
 * Tests:
 *   L1 — DefaultSessionControl.setYolo() writes the record correctly
 *        (documents the correct contract)
 *   L2 — SoulPlus onChanged listener: approvalStateStore.setYolo() flips
 *        the in-memory permission mode but does NOT write a wire record
 *        (the wire write belongs to the handler, not the listener)
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  InMemoryApprovalStateStore,
} from '../../src/soul-plus/approval-state-store.js';
import { DefaultSessionControl } from '../../src/soul-plus/session-control.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import { PathConfig } from '../../src/session/path-config.js';
import { SessionManager } from '../../src/session/session-manager.js';
import type { Runtime } from '../../src/soul/runtime.js';
import type { TurnManager } from '../../src/soul-plus/turn-manager.js';
import type { PermissionMode } from '../../src/soul-plus/permission/index.js';
import { createFakeRuntime } from '../soul/fixtures/fake-runtime.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';

// ── minimal TurnManager stub ─────────────────────────────────────────

function makeTurnManager(initial: PermissionMode = 'default'): TurnManager {
  let mode: PermissionMode = initial;
  return {
    getPermissionMode: () => mode,
    setPermissionMode: (m: PermissionMode) => { mode = m; },
    isIdle: () => true,
    tryReserveForMaintenance: () => true,
    releaseMaintenance: () => {},
    getLifecycleState: () => 'idle',
    setPlanMode: () => {},
    handlePrompt: () => {},
    handleCancel: () => {},
    handleSteer: () => {},
    addTurnLifecycleListener: () => {},
    removeTurnLifecycleListener: () => {},
    emitStatusUpdate: () => {},
    triggerCompaction: () => Promise.resolve(undefined),
  } as unknown as TurnManager;
}

function makeSessionControl(initialMode: PermissionMode = 'default') {
  const tm = makeTurnManager(initialMode);
  const journal = new InMemorySessionJournalImpl();
  const ctrl = new DefaultSessionControl({
    turnManager: tm,
    contextState: {} as never,
    sessionJournal: journal,
  });
  return { ctrl, journal, tm };
}

function createNoopRuntime(): Runtime {
  const kosong = new ScriptedKosongAdapter({ responses: [] });
  return createFakeRuntime({ kosong }).runtime;
}

// ── L1: DefaultSessionControl.setYolo — correct contract ─────────────

describe('DefaultSessionControl.setYolo — wire record contract (Phase 24 24a)', () => {
  it('setYolo(true) writes permission_mode_changed with to:bypassPermissions', async () => {
    const { ctrl, journal } = makeSessionControl('default');

    await ctrl.setYolo(true);

    const records = journal.getRecordsByType('permission_mode_changed');
    expect(records).toHaveLength(1);
    expect(records[0]!.data.to).toBe('bypassPermissions');
    expect(records[0]!.data.from).toBe('default');
    expect(records[0]!.data.reason.length).toBeGreaterThan(0);
  });

  it('setYolo(false) writes permission_mode_changed with to:default', async () => {
    const { ctrl, journal } = makeSessionControl('bypassPermissions');

    await ctrl.setYolo(false);

    const records = journal.getRecordsByType('permission_mode_changed');
    expect(records).toHaveLength(1);
    expect(records[0]!.data.to).toBe('default');
    expect(records[0]!.data.from).toBe('bypassPermissions');
  });

  it('setYolo(true) twice → only ONE record (idempotent short-circuit)', async () => {
    const { ctrl, journal } = makeSessionControl('default');

    await ctrl.setYolo(true);
    await ctrl.setYolo(true); // second call: oldMode === newMode → no-op

    const records = journal.getRecordsByType('permission_mode_changed');
    expect(records).toHaveLength(1); // not 2
  });
});

// ── L2: SoulPlus onChanged listener path — flips mode, NOT wire record ──

let tmpDir: string;
let paths: PathConfig;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kimi-24a-'));
  paths = new PathConfig({ home: tmpDir });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('SoulPlus onChanged listener — approvalStateStore.setYolo flips permissionMode (Phase 24 24a B-1)', () => {
  it('setYolo(true) via approvalStateStore flips TurnManager to bypassPermissions (no wire record here)', async () => {
    const mgr = new SessionManager(paths);
    const store = new InMemoryApprovalStateStore();

    const session = await mgr.createSession({
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
      approvalStateStore: store,
    });

    expect(session.soulPlus.getTurnManager().getPermissionMode()).toBe('default');
    await store.setYolo(true);
    // onChanged listener synchronously flips the mode:
    expect(session.soulPlus.getTurnManager().getPermissionMode()).toBe('bypassPermissions');
    await mgr.closeSession(session.sessionId);

    // Wire record is NOT written by the onChanged path — that belongs to
    // DefaultSessionControl.setYolo (called via session.setYolo wire handler).
    const wireFile = join(tmpDir, 'sessions', session.sessionId, 'wire.jsonl');
    const content = await readFile(wireFile, 'utf-8');
    const records = content.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string });
    const permChanges = records.filter((r) => r.type === 'permission_mode_changed');
    expect(permChanges).toHaveLength(0);
  });

  it('setYolo(false) after setYolo(true) flips mode back to default (no wire records)', async () => {
    const mgr = new SessionManager(paths);
    const store = new InMemoryApprovalStateStore();

    const session = await mgr.createSession({
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
      approvalStateStore: store,
    });

    await store.setYolo(true);
    expect(session.soulPlus.getTurnManager().getPermissionMode()).toBe('bypassPermissions');
    await store.setYolo(false);
    expect(session.soulPlus.getTurnManager().getPermissionMode()).toBe('default');
    await mgr.closeSession(session.sessionId);

    const wireFile = join(tmpDir, 'sessions', session.sessionId, 'wire.jsonl');
    const content = await readFile(wireFile, 'utf-8');
    const records = content.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string });
    expect(records.filter((r) => r.type === 'permission_mode_changed')).toHaveLength(0);
  });
});
