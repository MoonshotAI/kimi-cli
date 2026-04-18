/**
 * Phase 21 §A — production `session.subscribe` event-filter E2E (MAJOR-3).
 *
 * Pins that `session.subscribe({ events: [...] })` against the production
 * `src/wire-protocol/default-handlers.ts` actually narrows the wire
 * fan-out — previously this handler was a no-op stub returning `{ok:true}`
 * without touching `state.eventFilter`, so a client that subscribed to a
 * subset still received every event.
 *
 * The harness is deliberately inlined: the shared `createWireE2EHarness`
 * exercises the test helper variant (`test/helpers/wire/default-handlers
 * .ts`), which has its own subscribe implementation. This test must drive
 * the production code path.
 */
/* oxlint-disable import/max-dependencies */

import { afterEach, describe, expect, it } from 'vitest';

import { HookEngine } from '../../src/hooks/engine.js';
import { RequestRouter } from '../../src/router/request-router.js';
import {
  PathConfig,
  SessionManager,
} from '../../src/session/index.js';
import {
  AlwaysAllowApprovalRuntime,
  InMemoryApprovalStateStore,
  SessionEventBus,
  ToolCallOrchestrator,
} from '../../src/soul-plus/index.js';
import { createLinkedTransportPair, type MemoryTransport } from '../../src/transport/memory-transport.js';
import {
  WireCodec,
  createWireRequest,
  installWireEventBridge,
  registerDefaultWireHandlers,
  type WireMessage,
} from '../../src/wire-protocol/index.js';
import { mapToWireError } from '../../src/wire-protocol/error-mapping.js';
import {
  createTempEnv,
  FakeKosongAdapter,
  type TempEnvHandle,
} from '../helpers/index.js';

interface SubscribeHarness {
  request(req: WireMessage, timeoutMs?: number): Promise<WireMessage>;
  emitStatusUpdate(): void;
  collectedEventMethods(): string[];
  client: MemoryTransport;
  server: MemoryTransport;
  sessionManager: SessionManager;
  eventBus: SessionEventBus;
  dispose(): Promise<void>;
}

async function createSubscribeHarness(): Promise<{
  harness: SubscribeHarness;
  tempEnv: TempEnvHandle;
}> {
  const tempEnv = await createTempEnv();
  const pathConfig = new PathConfig({ home: tempEnv.homeDir.path });
  const sessionManager = new SessionManager(pathConfig);
  const eventBus = new SessionEventBus();
  const approval = new AlwaysAllowApprovalRuntime();
  const approvalStateStore = new InMemoryApprovalStateStore();
  const hookEngine = new HookEngine({ executors: new Map() });
  const kosong = new FakeKosongAdapter();
  const runtime = { kosong };
  const orchestrator = new ToolCallOrchestrator({
    hookEngine,
    sessionId: () => 'session_pending',
    agentId: 'agent_main',
    approvalRuntime: approval,
    pathConfig,
  });

  const router = new RequestRouter({ sessionManager });
  const [client, server] = createLinkedTransportPair();

  const handle = registerDefaultWireHandlers({
    sessionManager,
    router,
    runtime,
    kosong,
    tools: [],
    approval,
    orchestrator,
    eventBus,
    workspaceDir: tempEnv.workDir.path,
    defaultModel: 'test-model',
    pathConfig,
    server,
    hookEngine,
    approvalStateStore,
  });

  // Wrap createSession so each session gets a production WireEventBridge
  // wired into the per-session subscribe filter.
  const bridgeDisposers = new Map<string, () => void>();
  const originalCreate = sessionManager.createSession.bind(sessionManager);
  (sessionManager as { createSession: typeof sessionManager.createSession }).createSession =
    async (opts) => {
      const managed = await originalCreate(opts);
      const bridgeHandle = installWireEventBridge({
        server,
        eventBus,
        addTurnLifecycleListener: (l) =>
          managed.soulPlus.getTurnManager().addTurnLifecycleListener(l),
        sessionId: managed.sessionId,
        getEventFilter: () => handle.getEventFilter(managed.sessionId),
      });
      bridgeDisposers.set(managed.sessionId, bridgeHandle.dispose);
      return managed;
    };

  const codec = new WireCodec();
  const inbox: WireMessage[] = [];
  const waiters: Array<(msg: WireMessage) => void> = [];
  const collectedEvents: string[] = [];

  client.onMessage = (frame) => {
    try {
      const msg = codec.decode(frame);
      inbox.push(msg);
      if (msg.type === 'event' && typeof msg.method === 'string') {
        collectedEvents.push(msg.method);
      }
      for (const w of [...waiters]) w(msg);
    } catch {
      /* swallow malformed frames */
    }
  };

  server.onMessage = (frame) => {
    void (async () => {
      let msg: WireMessage;
      try {
        msg = codec.decode(frame);
      } catch (decodeError) {
        const mapping = mapToWireError(decodeError);
        const errResp = {
          id: 'res_decode_err',
          time: Date.now(),
          session_id: '__unknown__',
          type: 'response' as const,
          from: 'core',
          to: 'client',
          error: mapping.error,
        };
        try {
          await server.send(codec.encode(errResp as unknown as WireMessage));
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        const response = await router.dispatch(msg, server);
        if (response !== undefined) {
          await server.send(codec.encode(response));
        }
      } catch (error) {
        if (msg.type !== 'request') return;
        const mapping = mapToWireError(error);
        const errFrame = {
          id: `res_err_${msg.id}`,
          time: Date.now(),
          session_id: msg.session_id,
          type: 'response' as const,
          from: 'core',
          to: 'client',
          request_id: msg.id,
          error: mapping.error,
        };
        try {
          await server.send(codec.encode(errFrame as unknown as WireMessage));
        } catch {
          /* ignore */
        }
      }
    })();
  };

  await Promise.all([client.connect(), server.connect()]);

  const harness: SubscribeHarness = {
    client,
    server,
    sessionManager,
    eventBus,
    async request(req, timeoutMs = 5_000) {
      for (const m of inbox) {
        if (m.type === 'response' && m.request_id === req.id) return m;
      }
      const responsePromise = new Promise<WireMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(listener);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`request '${req.method ?? '(unknown)'}' (id=${req.id}) timed out after ${String(timeoutMs)}ms`));
        }, timeoutMs);
        const listener = (msg: WireMessage): void => {
          if (msg.type !== 'response') return;
          if (msg.request_id !== req.id) return;
          clearTimeout(timer);
          const idx = waiters.indexOf(listener);
          if (idx !== -1) waiters.splice(idx, 1);
          resolve(msg);
        };
        waiters.push(listener);
      });
      await client.send(codec.encode(req));
      return responsePromise;
    },
    emitStatusUpdate(): void {
      eventBus.emit({ type: 'status.update', data: { plan_mode: true } });
    },
    collectedEventMethods(): string[] {
      return [...collectedEvents];
    },
    async dispose() {
      for (const dispose of bridgeDisposers.values()) dispose();
      bridgeDisposers.clear();
      const live = await sessionManager.listSessions();
      for (const info of live) {
        try {
          await sessionManager.closeSession(info.session_id);
        } catch {
          /* best-effort */
        }
      }
      await client.close();
    },
  };
  return { harness, tempEnv };
}

let pending: { harness: SubscribeHarness; tempEnv: TempEnvHandle } | undefined;

afterEach(async () => {
  if (pending !== undefined) {
    await pending.harness.dispose();
    await pending.tempEnv.cleanup();
    pending = undefined;
  }
});

async function bootSession(harness: SubscribeHarness): Promise<string> {
  const initReq = createWireRequest({
    method: 'initialize',
    sessionId: '__process__',
    data: {},
  });
  const initRes = await harness.request(initReq);
  expect(initRes.error).toBeUndefined();
  const createReq = createWireRequest({
    method: 'session.create',
    sessionId: '__process__',
    data: { model: 'test-model' },
  });
  const createRes = await harness.request(createReq);
  expect(createRes.error).toBeUndefined();
  return (createRes.data as { session_id: string }).session_id;
}

// Tiny helper — wait for the bridge's microtask + fan-out queue to drain.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

describe('Phase 21 §A — production session.subscribe filter (MAJOR-3)', () => {
  it('subscribe({events:[turn.begin]}) drops a status.update emit', async () => {
    pending = await createSubscribeHarness();
    const sessionId = await bootSession(pending.harness);

    // Narrow to a single event method that we will NOT emit, so any
    // status.update that lands on the client must have leaked past the
    // filter — that's the regression.
    const subReq = createWireRequest({
      method: 'session.subscribe',
      sessionId,
      data: { events: ['turn.begin'] },
    });
    const subRes = await pending.harness.request(subReq);
    expect(subRes.error).toBeUndefined();

    pending.harness.emitStatusUpdate();
    await flush();

    expect(pending.harness.collectedEventMethods()).not.toContain('status.update');
  });

  it('unsubscribe restores the default (all events) fan-out', async () => {
    pending = await createSubscribeHarness();
    const sessionId = await bootSession(pending.harness);

    // First narrow, then clear, then emit — the emit MUST land.
    const subReq = createWireRequest({
      method: 'session.subscribe',
      sessionId,
      data: { events: ['turn.begin'] },
    });
    expect((await pending.harness.request(subReq)).error).toBeUndefined();

    const unsubReq = createWireRequest({
      method: 'session.unsubscribe',
      sessionId,
      data: {},
    });
    expect((await pending.harness.request(unsubReq)).error).toBeUndefined();

    pending.harness.emitStatusUpdate();
    await flush();

    expect(pending.harness.collectedEventMethods()).toContain('status.update');
  });

  it('default (no subscribe call) fans out every event method', async () => {
    pending = await createSubscribeHarness();
    await bootSession(pending.harness);

    pending.harness.emitStatusUpdate();
    await flush();

    expect(pending.harness.collectedEventMethods()).toContain('status.update');
  });
});
