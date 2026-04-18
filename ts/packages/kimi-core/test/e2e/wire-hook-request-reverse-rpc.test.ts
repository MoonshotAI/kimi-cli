/**
 * Phase 21 §A — `hook.request` reverse-RPC E2E (production surface).
 *
 * Pins the production wire path that registers `WireHookExecutor` from
 * `initialize.hooks[]` and dispatches `hook.request` reverse-RPC frames.
 *
 * Three scenarios:
 *   1. round-trip — client returns `{ok:true, blockAction:true, reason}`
 *      → `hookEngine.executeHooks` aggregates `{blockAction:true, reason}`.
 *   2. timeout    — client never responds within `hookTimeoutMs`
 *      → executor fail-opens (`blockAction:false`).
 *   3. malformed  — client returns an unparseable / non-conforming payload
 *      → executor fail-opens rather than crashing the turn.
 *
 * Drives the production `src/wire-protocol/default-handlers.ts`, NOT the
 * test-helper variant. The production handler captures `initialize.hooks[]`,
 * registers a `WireHookExecutor` against the shared `HookEngine`, and the
 * executor uses the reverse-RPC client to send `hook.request` frames.
 */
/* oxlint-disable import/max-dependencies */

import { afterEach, describe, expect, it } from 'vitest';

import { HookEngine } from '../../src/hooks/engine.js';
import { RequestRouter } from '../../src/router/request-router.js';
import { PathConfig, SessionManager } from '../../src/session/index.js';
import {
  AlwaysAllowApprovalRuntime,
  InMemoryApprovalStateStore,
  SessionEventBus,
  ToolCallOrchestrator,
} from '../../src/soul-plus/index.js';
import {
  createLinkedTransportPair,
  type MemoryTransport,
} from '../../src/transport/memory-transport.js';
import {
  WireCodec,
  createWireRequest,
  createWireResponse,
  registerDefaultWireHandlers,
  type WireMessage,
} from '../../src/wire-protocol/index.js';
import { mapToWireError } from '../../src/wire-protocol/error-mapping.js';
import {
  createTempEnv,
  FakeKosongAdapter,
  type TempEnvHandle,
} from '../helpers/index.js';

interface HookE2EHarness {
  request(req: WireMessage, timeoutMs?: number): Promise<WireMessage>;
  onReverseRequest(handler: (req: WireMessage) => WireMessage | undefined): void;
  hookEngine: HookEngine;
  client: MemoryTransport;
  server: MemoryTransport;
  sessionManager: SessionManager;
  dispose(): Promise<void>;
}

async function createHookHarness(opts: {
  hookTimeoutMs: number;
}): Promise<{ harness: HookE2EHarness; tempEnv: TempEnvHandle }> {
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
    hookTimeoutMs: opts.hookTimeoutMs,
  });

  const codec = new WireCodec();
  const inbox: WireMessage[] = [];
  const responseWaiters: Array<(msg: WireMessage) => void> = [];
  let reverseHandler: ((req: WireMessage) => WireMessage | undefined) | undefined;

  client.onMessage = (frame) => {
    let msg: WireMessage;
    try {
      msg = codec.decode(frame);
    } catch {
      return;
    }
    inbox.push(msg);
    for (const w of [...responseWaiters]) w(msg);
    // Server-initiated reverse RPC: type='request', from='core'.
    if (msg.type === 'request' && reverseHandler !== undefined) {
      const reply = reverseHandler(msg);
      if (reply !== undefined) {
        void client.send(codec.encode(reply)).catch(() => {
          /* ignore */
        });
      }
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

  const harness: HookE2EHarness = {
    client,
    server,
    sessionManager,
    hookEngine,
    onReverseRequest(handler) {
      reverseHandler = handler;
    },
    async request(req, timeoutMs = 5_000): Promise<WireMessage> {
      for (const m of inbox) {
        if (m.type === 'response' && m.request_id === req.id) return m;
      }
      const responsePromise = new Promise<WireMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = responseWaiters.indexOf(listener);
          if (idx !== -1) responseWaiters.splice(idx, 1);
          reject(
            new Error(
              `request '${req.method ?? '(unknown)'}' (id=${req.id}) timed out after ${String(timeoutMs)}ms`,
            ),
          );
        }, timeoutMs);
        const listener = (msg: WireMessage): void => {
          if (msg.type !== 'response') return;
          if (msg.request_id !== req.id) return;
          clearTimeout(timer);
          const idx = responseWaiters.indexOf(listener);
          if (idx !== -1) responseWaiters.splice(idx, 1);
          resolve(msg);
        };
        responseWaiters.push(listener);
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

/**
 * Boot the harness, register one PreToolUse hook via `initialize.hooks[]`,
 * create a session, and seed `perSession` (so the `WireHookExecutor`
 * sender resolves the right session id when issuing `hook.request`).
 *
 * Returns the live session id.
 */
async function bootWithHook(
  pending: { harness: HookE2EHarness; tempEnv: TempEnvHandle },
  opts?: { matcher?: string; subscriptionId?: string },
): Promise<string> {
  const initReq = createWireRequest({
    method: 'initialize',
    sessionId: '__process__',
    data: {
      hooks: [
        {
          event: 'PreToolUse',
          matcher: opts?.matcher ?? 'TestTool',
          id: opts?.subscriptionId ?? 'hk_test',
        },
      ],
    },
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

  // Seed perSession so the WireHookExecutor's sender resolves the
  // correct session id when issuing hook.request frames. unsubscribe
  // is the cheapest method that touches `getOrInitSessionState`.
  const seedReq = createWireRequest({
    method: 'session.unsubscribe',
    sessionId,
    data: {},
  });
  const seedRes = await pending.harness.request(seedReq);
  expect(seedRes.error).toBeUndefined();
  return sessionId;
}

let pending:
  | { harness: HookE2EHarness; tempEnv: TempEnvHandle }
  | undefined;

afterEach(async () => {
  if (pending !== undefined) {
    await pending.harness.dispose();
    await pending.tempEnv.cleanup();
    pending = undefined;
  }
});

describe('Phase 21 §A — hook.request reverse-RPC (production surface)', () => {
  it('round-trip: client returns {blockAction:true, reason} → executor aggregates the block', async () => {
    pending = await createHookHarness({ hookTimeoutMs: 2_000 });
    const sessionId = await bootWithHook(pending);

    let observedHookRequest: WireMessage | undefined;
    pending.harness.onReverseRequest((req) => {
      if (req.method !== 'hook.request') return undefined;
      observedHookRequest = req;
      return createWireResponse({
        requestId: req.id,
        sessionId: req.session_id,
        data: {
          ok: true,
          blockAction: true,
          reason: 'blocked by phase21 test',
          additional_context: 'extra-ctx-from-client',
        },
      });
    });

    const ac = new AbortController();
    const result = await pending.harness.hookEngine.executeHooks(
      'PreToolUse',
      {
        event: 'PreToolUse',
        sessionId,
        turnId: 'turn_round_trip',
        agentId: 'agent_main',
        toolCall: { id: 'tc_block', name: 'TestTool', args: { foo: 1 } },
        args: { foo: 1 },
      },
      ac.signal,
    );

    expect(result.blockAction).toBe(true);
    expect(result.reason).toBe('blocked by phase21 test');
    expect(result.additionalContext).toContain('extra-ctx-from-client');

    expect(observedHookRequest).toBeDefined();
    expect(observedHookRequest!.method).toBe('hook.request');
    const data = observedHookRequest!.data as {
      event?: string;
      tool_name?: string;
      session_id?: string;
      subscription_id?: string;
    };
    expect(data.event).toBe('PreToolUse');
    expect(data.tool_name).toBe('TestTool');
    expect(data.session_id).toBe(sessionId);
    expect(data.subscription_id).toBe('hk_test');
  });

  it('timeout: client never responds → executor fail-opens (blockAction:false)', async () => {
    // Tight timeout so the test runs fast.
    pending = await createHookHarness({ hookTimeoutMs: 150 });
    const sessionId = await bootWithHook(pending);

    let sawHookRequest = false;
    pending.harness.onReverseRequest((req) => {
      if (req.method === 'hook.request') {
        sawHookRequest = true;
        // Intentionally drop the request — never reply.
      }
      return undefined;
    });

    const ac = new AbortController();
    const result = await pending.harness.hookEngine.executeHooks(
      'PreToolUse',
      {
        event: 'PreToolUse',
        sessionId,
        turnId: 'turn_timeout',
        agentId: 'agent_main',
        toolCall: { id: 'tc_to', name: 'TestTool', args: {} },
        args: {},
      },
      ac.signal,
    );

    expect(sawHookRequest).toBe(true);
    expect(result.blockAction).toBe(false);
    expect(result.additionalContext).toEqual([]);
  });

  it('malformed: client returns garbage payload → executor fail-opens (blockAction:false)', async () => {
    pending = await createHookHarness({ hookTimeoutMs: 2_000 });
    const sessionId = await bootWithHook(pending);

    pending.harness.onReverseRequest((req) => {
      if (req.method !== 'hook.request') return undefined;
      // Reply with a payload that has no recognisable hook fields. The
      // executor must treat the missing `ok` flag as a default-true /
      // no-block result rather than throwing.
      return createWireResponse({
        requestId: req.id,
        sessionId: req.session_id,
        data: { unrelated: 'garbage', nested: { random: true } },
      });
    });

    const ac = new AbortController();
    const result = await pending.harness.hookEngine.executeHooks(
      'PreToolUse',
      {
        event: 'PreToolUse',
        sessionId,
        turnId: 'turn_malformed',
        agentId: 'agent_main',
        toolCall: { id: 'tc_mal', name: 'TestTool', args: {} },
        args: {},
      },
      ac.signal,
    );

    expect(result.blockAction).toBe(false);
    expect(result.additionalContext).toEqual([]);
  });
});
