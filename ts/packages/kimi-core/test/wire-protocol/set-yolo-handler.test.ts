/**
 * Phase 24 RR2-B-B — handler-level test.
 *
 * Proves that the production `session.setYolo` wire handler writes a
 * `permission_mode_changed` record to wire.jsonl, even when an
 * `approvalStateStore` is present.
 *
 * RR2-B-B ordering invariant:
 *   sessionControl.setYolo(enabled) FIRST  → writes permission_mode_changed
 *   approvalStateStore.setYolo(enabled) AFTER → onChanged listener, idempotent
 *
 * If the order were reversed the onChanged listener would flip
 * TurnManager.permissionMode before sessionControl.setYolo ran; the
 * idempotent short-circuit in DefaultSessionControl would then see
 * previousMode === newMode and skip appendPermissionModeChanged — record lost.
 *
 * Tests:
 *   H1 — setYolo(true)  → permission_mode_changed {to:'bypassPermissions'}
 *   H2 — setYolo(false) after setYolo(true) → {to:'default'} record
 *   H3 — idempotent: second setYolo(true) → no additional record
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryApprovalStateStore } from '../../src/soul-plus/approval-state-store.js';
import { SessionEventBus } from '../../src/soul-plus/session-event-bus.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { PathConfig } from '../../src/session/path-config.js';
import { RequestRouter } from '../../src/router/request-router.js';
import { registerDefaultWireHandlers } from '../../src/wire-protocol/default-handlers.js';
import { createWireRequest } from '../../src/wire-protocol/message-factory.js';
import type { Transport } from '../../src/transport/types.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';
import { createFakeRuntime } from '../soul/fixtures/fake-runtime.js';
import { createTestApproval } from '../helpers/runtime/internal-deps.js';

// ── Minimal stub transport ──────────────────────────────────────────────────
// The session.setYolo handler does not use the transport (_t is unused).
function makeStubTransport(): Transport {
  return {
    state: 'connected' as const,
    connect: async () => {},
    send: async () => {},
    close: async () => {},
    onMessage: null,
    onConnect: null,
    onClose: null,
    onError: null,
  };
}

// ── Test fixtures ───────────────────────────────────────────────────────────

let tmpDir: string;
let paths: PathConfig;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kimi-rr2bb-'));
  paths = new PathConfig({ home: tmpDir });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// Creates a sessionManager + router wired with production handlers, plus a
// real session whose approvalStateStore listener is wired (so the onChanged
// path would flip TurnManager if the handler called store.setYolo first).
async function bootHandlerEnv() {
  const approvalStateStore = new InMemoryApprovalStateStore();
  const eventBus = new SessionEventBus();
  const sessionManager = new SessionManager(paths);
  const router = new RequestRouter({ sessionManager });
  const kosong = new ScriptedKosongAdapter({ responses: [] });
  const { runtime } = createFakeRuntime({ kosong });
  const approval = createTestApproval({ yolo: true });

  registerDefaultWireHandlers({
    sessionManager,
    router,
    runtime,
    kosong,
    tools: [],
    approval,
    eventBus,
    workspaceDir: tmpDir,
    defaultModel: 'test-model',
    pathConfig: paths,
    approvalStateStore,
  });

  // Create the session WITH approvalStateStore so the onChanged listener is
  // installed in SoulPlus. This is the critical prerequisite for RR2-B-B:
  // if the handler called store.setYolo before sessionControl.setYolo, the
  // listener would flip TurnManager first and the wire record would be lost.
  const managed = await sessionManager.createSession({
    runtime,
    tools: [],
    model: 'test-model',
    workspaceDir: tmpDir,
    eventBus,
    approvalStateStore,
  });

  return { sessionId: managed.sessionId, sessionManager, router };
}

async function readPermRecords(sessionId: string) {
  const content = await readFile(paths.wirePath(sessionId), 'utf-8');
  return content
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; data?: Record<string, unknown> })
    .filter((r) => r.type === 'permission_mode_changed');
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('session.setYolo handler — wire record written (Phase 24 RR2-B-B)', () => {
  it('H1 — setYolo(true) → permission_mode_changed {to:bypassPermissions} in wire.jsonl', async () => {
    const { sessionId, sessionManager, router } = await bootHandlerEnv();
    const transport = makeStubTransport();

    await router.dispatch(
      createWireRequest({ method: 'session.setYolo', sessionId, data: { enabled: true } }),
      transport,
    );
    await sessionManager.closeSession(sessionId);

    const records = await readPermRecords(sessionId);
    expect(records).toHaveLength(1);
    expect(records[0]!.data?.['to']).toBe('bypassPermissions');
    expect(records[0]!.data?.['from']).toBe('default');
  });

  it('H2 — setYolo(true) then setYolo(false) → two records, second {to:default}', async () => {
    const { sessionId, sessionManager, router } = await bootHandlerEnv();
    const transport = makeStubTransport();

    await router.dispatch(
      createWireRequest({ method: 'session.setYolo', sessionId, data: { enabled: true } }),
      transport,
    );
    await router.dispatch(
      createWireRequest({ method: 'session.setYolo', sessionId, data: { enabled: false } }),
      transport,
    );
    await sessionManager.closeSession(sessionId);

    const records = await readPermRecords(sessionId);
    expect(records).toHaveLength(2);
    expect(records[0]!.data?.['to']).toBe('bypassPermissions');
    expect(records[1]!.data?.['to']).toBe('default');
  });

  it('H3 — idempotent: second setYolo(true) adds no additional record', async () => {
    const { sessionId, sessionManager, router } = await bootHandlerEnv();
    const transport = makeStubTransport();

    await router.dispatch(
      createWireRequest({ method: 'session.setYolo', sessionId, data: { enabled: true } }),
      transport,
    );
    await router.dispatch(
      createWireRequest({ method: 'session.setYolo', sessionId, data: { enabled: true } }),
      transport,
    );
    await sessionManager.closeSession(sessionId);

    const records = await readPermRecords(sessionId);
    expect(records).toHaveLength(1); // NOT 2 — idempotent short-circuit
  });
});
