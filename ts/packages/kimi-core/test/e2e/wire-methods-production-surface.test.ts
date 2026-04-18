/**
 * Phase 21 §A — production wire surface E2E.
 *
 * Pins that the **production** `src/wire-protocol/default-handlers.ts`
 * registers every method advertised in `initialize.capabilities.methods`
 * (and that the constant covers the Phase 18 §A delta). This test exists
 * to prevent the Phase 18 → ts-rewrite-work merge regression where the
 * test helper kept the eight Section-A handlers but the production
 * file dropped them, leaving wire clients with `-32601 Method not found`.
 *
 * The harness is intentionally inlined: it must drive
 * `src/wire-protocol/default-handlers.ts`, NOT `test/helpers/wire/
 * default-handlers.ts`. Shared `createWireE2EHarness` wires the test
 * helper variant by design.
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
  registerDefaultWireHandlers,
  type WireMessage,
} from '../../src/wire-protocol/index.js';
import { mapToWireError } from '../../src/wire-protocol/error-mapping.js';
import {
  createTempEnv,
  FakeKosongAdapter,
  type TempEnvHandle,
} from '../helpers/index.js';

interface ProductionHarness {
  send(req: WireMessage): Promise<void>;
  request(req: WireMessage, timeoutMs?: number): Promise<WireMessage>;
  client: MemoryTransport;
  server: MemoryTransport;
  sessionManager: SessionManager;
  dispose(): Promise<void>;
}

async function createProductionHarness(opts?: {
  rebuildRuntimeForModel?: (sessionId: string, model: string) => Promise<void> | void;
}): Promise<{
  harness: ProductionHarness;
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

  registerDefaultWireHandlers({
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
    ...(opts?.rebuildRuntimeForModel !== undefined
      ? { rebuildRuntimeForModel: opts.rebuildRuntimeForModel }
      : {}),
  });

  const codec = new WireCodec();
  const inbox: WireMessage[] = [];
  const waiters: Array<(msg: WireMessage) => void> = [];

  client.onMessage = (frame) => {
    try {
      const msg = codec.decode(frame);
      inbox.push(msg);
      // Fan out to waiters; clone so a self-removing waiter doesn't skip neighbours.
      for (const w of Array.from(waiters)) w(msg);
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
        // Pattern-match "method not found" → -32601 the same way the
        // harness's wire-e2e-harness does; mapToWireError otherwise
        // collapses every router throw into -32603 and would mask the
        // exact regression this test pins.
        const errMsg = error instanceof Error ? error.message : String(error);
        const isMethodNotFound = /method not found/i.test(errMsg);
        const mapping = isMethodNotFound
          ? { error: { code: -32601, message: errMsg } }
          : mapToWireError(error);
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

  const harness: ProductionHarness = {
    client,
    server,
    sessionManager,
    async send(req) {
      await client.send(codec.encode(req));
    },
    async request(req, timeoutMs = 5_000): Promise<WireMessage> {
      // Fast-path scan in case the response already landed (defensive).
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
    async dispose() {
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

let pending: { harness: ProductionHarness; tempEnv: TempEnvHandle } | undefined;

afterEach(async () => {
  if (pending !== undefined) {
    await pending.harness.dispose();
    await pending.tempEnv.cleanup();
    pending = undefined;
  }
});

describe('Phase 21 §A — production wire surface', () => {
  it('initialize.capabilities.methods covers the 8 Phase 18 §A methods (≥22 total)', async () => {
    pending = await createProductionHarness();
    const initReq = createWireRequest({
      method: 'initialize',
      sessionId: '__process__',
      data: {},
    });
    const res = await pending.harness.request(initReq);
    expect(res.error).toBeUndefined();
    const methods = (res.data as {
      capabilities: { methods: string[] };
    }).capabilities.methods;
    const required = [
      'session.setModel',
      'session.setThinking',
      'session.addSystemReminder',
      'session.registerTool',
      'session.removeTool',
      'session.listTools',
      'session.setActiveTools',
      'session.unsubscribe',
    ];
    const missing = required.filter((m) => !methods.includes(m));
    expect(missing).toEqual([]);
    expect(methods.length).toBeGreaterThanOrEqual(22);
  });

  it('each Phase 18 §A method round-trips against the production handlers (no -32601)', async () => {
    pending = await createProductionHarness();

    // Boot: initialize → session.create.
    const initReq = createWireRequest({
      method: 'initialize',
      sessionId: '__process__',
      data: {},
    });
    const initRes = await pending.harness.request(initReq);
    expect(initRes.error).toBeUndefined();

    const createReq = createWireRequest({
      method: 'session.create',
      sessionId: '__process__',
      data: { model: 'test-model' },
    });
    const createRes = await pending.harness.request(createReq);
    expect(createRes.error).toBeUndefined();
    const sessionId = (createRes.data as { session_id: string }).session_id;

    type Probe = { method: string; data: unknown };
    const probes: readonly Probe[] = [
      { method: 'session.setModel', data: { model: 'test-model-alt' } },
      { method: 'session.setThinking', data: { level: 'medium' } },
      { method: 'session.addSystemReminder', data: { content: 'phase-21 reminder' } },
      {
        method: 'session.registerTool',
        data: {
          name: 'phase21_probe_tool',
          description: 'phase 21 production surface probe',
          input_schema: { type: 'object' },
        },
      },
      { method: 'session.listTools', data: {} },
      { method: 'session.setActiveTools', data: { names: ['phase21_probe_tool'] } },
      { method: 'session.removeTool', data: { name: 'phase21_probe_tool' } },
      { method: 'session.unsubscribe', data: {} },
    ];

    for (const probe of probes) {
      const req = createWireRequest({
        method: probe.method,
        sessionId,
        data: probe.data,
      });
      const res = await pending.harness.request(req);
      // The point of this regression test is "method-not-found must not
      // happen". Other business errors are acceptable for probes that
      // touch real subsystems (e.g. setModel rebuild path).
      const code = res.error?.code;
      // Phase 21 review hotfix — when the method is genuinely missing
      // the router now throws WireMethodNotFoundError → -32601, so this
      // assertion has real teeth. Prior to the fix the router raised a
      // generic Error which error-mapping collapsed into -32603,
      // silently neutering this regression gate.
      if (code === -32601) {
        throw new Error(
          `wire method ${probe.method} returned -32601 Method not found — ` +
            `production handler missing; Phase 18 §A merge regression again?`,
        );
      }
    }
  });

  it('session.registerTool throws when no reverse-RPC channel is wired (MAJOR-4)', async () => {
    // Build a harness whose production handlers were registered without
    // the `server` transport, so `reverse === undefined`. Before the fix,
    // the handler silently returned `{ok: true}` and stashed the tool in
    // perSession state — `session.listTools` would then advertise a tool
    // that no client could ever invoke (no `tool.call` reverse path).
    const tempEnv = await createTempEnv();
    const pathConfig = new PathConfig({ home: tempEnv.homeDir.path });
    const sessionManager = new SessionManager(pathConfig);
    const eventBus = new SessionEventBus();
    const approval = new AlwaysAllowApprovalRuntime();
    const approvalStateStore = new InMemoryApprovalStateStore();
    const hookEngine = new HookEngine({ executors: new Map() });
    const kosong = new FakeKosongAdapter();
    const orchestrator = new ToolCallOrchestrator({
      hookEngine,
      sessionId: () => 'session_pending',
      agentId: 'agent_main',
      approvalRuntime: approval,
      pathConfig,
    });

    const router = new RequestRouter({ sessionManager });
    const [client, server] = createLinkedTransportPair();

    registerDefaultWireHandlers({
      sessionManager,
      router,
      runtime: { kosong },
      kosong,
      tools: [],
      approval,
      orchestrator,
      eventBus,
      workspaceDir: tempEnv.workDir.path,
      defaultModel: 'test-model',
      pathConfig,
      // server intentionally omitted — exercises the no-reverse path.
      hookEngine,
      approvalStateStore,
    });

    const codec = new WireCodec();
    const inbox: WireMessage[] = [];
    const waiters: Array<(msg: WireMessage) => void> = [];
    client.onMessage = (frame) => {
      try {
        const msg = codec.decode(frame);
        inbox.push(msg);
        for (const w of Array.from(waiters)) w(msg);
      } catch {
        /* ignore */
      }
    };
    server.onMessage = (frame) => {
      void (async () => {
        let msg: WireMessage;
        try {
          msg = codec.decode(frame);
        } catch {
          return;
        }
        try {
          const response = await router.dispatch(msg, server);
          if (response !== undefined) await server.send(codec.encode(response));
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

    const sendAndWait = async (req: WireMessage): Promise<WireMessage> => {
      const p = new Promise<WireMessage>((resolve) => {
        const listener = (msg: WireMessage): void => {
          if (msg.type !== 'response') return;
          if (msg.request_id !== req.id) return;
          const idx = waiters.indexOf(listener);
          if (idx !== -1) waiters.splice(idx, 1);
          resolve(msg);
        };
        waiters.push(listener);
      });
      await client.send(codec.encode(req));
      return p;
    };

    try {
      const initRes = await sendAndWait(createWireRequest({
        method: 'initialize',
        sessionId: '__process__',
        data: {},
      }));
      expect(initRes.error).toBeUndefined();

      const createRes = await sendAndWait(createWireRequest({
        method: 'session.create',
        sessionId: '__process__',
        data: { model: 'test-model' },
      }));
      expect(createRes.error).toBeUndefined();
      const sessionId = (createRes.data as { session_id: string }).session_id;

      const regReq = createWireRequest({
        method: 'session.registerTool',
        sessionId,
        data: {
          name: 'major4_probe',
          description: 'major4 no-reverse probe',
          input_schema: { type: 'object' },
        },
      });
      const regRes = await sendAndWait(regReq);
      // Pre-fix: regRes.error === undefined and `data.ok === true`.
      expect(regRes.error).toBeDefined();
      expect(regRes.error?.message).toMatch(/reverse-RPC/i);

      // listTools must NOT advertise the failed-to-register tool.
      const listRes = await sendAndWait(createWireRequest({
        method: 'session.listTools',
        sessionId,
        data: {},
      }));
      const tools = ((listRes.data ?? {}) as { tools?: Array<{ name: string }> }).tools ?? [];
      expect(tools.find((t) => t.name === 'major4_probe')).toBeUndefined();
    } finally {
      const live = await sessionManager.listSessions();
      for (const info of live) {
        try {
          await sessionManager.closeSession(info.session_id);
        } catch {
          /* ignore */
        }
      }
      await client.close();
      await tempEnv.cleanup();
    }
  });

  it('session.setModel invokes the host rebuildRuntimeForModel callback with (sessionId, model)', async () => {
    const calls: Array<{ sessionId: string; model: string }> = [];
    pending = await createProductionHarness({
      rebuildRuntimeForModel: (sessionId, model) => {
        calls.push({ sessionId, model });
        // The callback is responsible for the full destroy+resume dance
        // in production. For this regression pin we only care that the
        // handler delegated — no need to rebuild the runtime. Returning
        // without tearing the session down is acceptable because the
        // production handler skips its own `setModel` call when the
        // callback is wired (default-handlers.ts §session.setModel).
      },
    });

    const initReq = createWireRequest({
      method: 'initialize',
      sessionId: '__process__',
      data: {},
    });
    const initRes = await pending.harness.request(initReq);
    expect(initRes.error).toBeUndefined();

    const createReq = createWireRequest({
      method: 'session.create',
      sessionId: '__process__',
      data: { model: 'test-model' },
    });
    const createRes = await pending.harness.request(createReq);
    expect(createRes.error).toBeUndefined();
    const sessionId = (createRes.data as { session_id: string }).session_id;

    const setModelReq = createWireRequest({
      method: 'session.setModel',
      sessionId,
      data: { model: 'kimi-pro-2026' },
    });
    const setModelRes = await pending.harness.request(setModelReq);
    expect(setModelRes.error).toBeUndefined();
    expect(calls).toEqual([{ sessionId, model: 'kimi-pro-2026' }]);
  });
});
