/**
 * Default wire handler registrations for the in-memory harness
 * (Review M1).
 *
 * Phase 11 will ship the production `--wire` runner with its own
 * handler wiring. Until then the in-memory wire harness needs a
 * working set so Phase 10 tests can exercise
 * `initialize → session.create → session.prompt` without building
 * their own router setup.
 *
 * The handlers mirror the contracts in `src/wire-protocol/types.ts`
 * (process / conversation / management / config channels) and
 * delegate to the real `SessionManager` + `SoulPlus` where possible.
 * `from` / `to` envelope fields are faithful but opaque — Phase 10
 * may override individual handlers via `routerOverrides`.
 */

import type { KosongAdapter, Runtime } from '../../../src/soul/runtime.js';
import type { Tool } from '../../../src/soul/types.js';
import type { ApprovalRuntime } from '../../../src/soul-plus/approval-runtime.js';
import type { ToolCallOrchestrator } from '../../../src/soul-plus/orchestrator.js';
import type { SessionEventBus } from '../../../src/soul-plus/session-event-bus.js';
import type { DispatchResponse } from '../../../src/soul-plus/types.js';
import type { SessionManager } from '../../../src/session/session-manager.js';
import type { RequestRouter } from '../../../src/router/request-router.js';
import { createWireEvent, createWireResponse } from '../../../src/wire-protocol/message-factory.js';
import {
  WIRE_PROTOCOL_VERSION,
  type InitializeResponseData,
  type SessionCancelRequestData,
  type SessionCreateRequestData,
  type SessionCreateResponseData,
  type SessionPromptRequestData,
  type SessionSteerRequestData,
  type WireMessage,
} from '../../../src/wire-protocol/types.js';

export interface DefaultHandlersDeps {
  readonly sessionManager: SessionManager;
  readonly router: RequestRouter;
  readonly runtime: Runtime;
  readonly kosong: KosongAdapter;
  readonly tools: readonly Tool[];
  readonly approval: ApprovalRuntime;
  readonly orchestrator?: ToolCallOrchestrator | undefined;
  readonly eventBus: SessionEventBus;
  readonly workspaceDir: string;
  readonly defaultModel: string;
}

/**
 * Register default process/session handlers on the router. The
 * returned handle exposes `listenedSessions` so callers can inspect
 * what sessions the harness tracks.
 */
export function registerDefaultWireHandlers(deps: DefaultHandlersDeps): void {
  const { router, sessionManager, runtime, tools, eventBus, workspaceDir, defaultModel, orchestrator } = deps;

  // ── Process channel ──────────────────────────────────────────────

  router.registerProcessMethod('initialize', async (msg): Promise<WireMessage> => {
    const data: InitializeResponseData = {
      protocol_version: WIRE_PROTOCOL_VERSION,
      capabilities: {
        events: [
          'turn.begin',
          'turn.end',
          'step.begin',
          'step.end',
          'content.delta',
          'tool.call',
          'tool.result',
          'status.update',
          'session.error',
        ],
        methods: [
          'initialize',
          'session.create',
          'session.list',
          'session.destroy',
          'session.prompt',
          'session.steer',
          'session.cancel',
          'session.getStatus',
          'session.getHistory',
          'session.subscribe',
          'session.compact',
          'shutdown',
        ],
      },
    };
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data,
    });
  });

  router.registerProcessMethod('session.create', async (msg): Promise<WireMessage> => {
    const payload = (msg.data ?? {}) as SessionCreateRequestData;
    const managed = await sessionManager.createSession({
      ...(payload.session_id !== undefined ? { sessionId: payload.session_id } : {}),
      runtime,
      tools,
      model: payload.model ?? defaultModel,
      ...(payload.system_prompt !== undefined ? { systemPrompt: payload.system_prompt } : {}),
      eventBus,
      workspaceDir,
      ...(orchestrator !== undefined ? { orchestrator } : {}),
    });
    const data: SessionCreateResponseData = { session_id: managed.sessionId };
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data,
    });
  });

  router.registerProcessMethod('session.list', async (msg): Promise<WireMessage> => {
    const list = await sessionManager.listSessions();
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { sessions: list },
    });
  });

  router.registerProcessMethod('session.destroy', async (msg): Promise<WireMessage> => {
    const payload = (msg.data ?? {}) as { session_id?: string };
    if (payload.session_id !== undefined) {
      await sessionManager.closeSession(payload.session_id);
    }
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  router.registerProcessMethod('shutdown', async (msg): Promise<WireMessage> => {
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  // ── Conversation channel ─────────────────────────────────────────

  router.registerMethod('session.prompt', 'conversation', async (msg, transport, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const payload = (msg.data ?? {}) as SessionPromptRequestData;
    // Phase 14 §3.5 — `input` widened to `string | UserInputPart[]`.
    // Preserve parts alongside the flattened text so the turn.begin
    // wire event can surface them (see `wire-event-bridge` fallback).
    let inputText: string;
    let inputParts: readonly import('../../../src/wire-protocol/types.js').UserInputPart[] | undefined;
    if (typeof payload.input === 'string') {
      inputText = payload.input;
      inputParts = undefined;
    } else {
      inputText = payload.input
        .map((part) => {
          if (part.type === 'text') return part.text;
          if (part.type === 'image_url') return `<image url="${part.image_url.url}">`;
          return `<video url="${part.video_url.url}">`;
        })
        .join('');
      inputParts = payload.input;
    }
    const dispatch = await managed.soulPlus.dispatch({
      method: 'session.prompt',
      data: {
        input: {
          text: inputText,
          ...(inputParts !== undefined ? { parts: inputParts } : {}),
        },
      },
    });
    void transport;
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: dispatch as unknown as DispatchResponse,
    });
  });

  router.registerMethod('session.steer', 'conversation', async (msg, _transport, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const payload = (msg.data ?? {}) as SessionSteerRequestData;
    const dispatch = await managed.soulPlus.dispatch({
      method: 'session.steer',
      data: { input: { text: payload.input } },
    });
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: dispatch,
    });
  });

  router.registerMethod('session.cancel', 'conversation', async (msg, _transport, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const payload = (msg.data ?? {}) as SessionCancelRequestData;
    const dispatch = await managed.soulPlus.dispatch({
      method: 'session.cancel',
      data: payload.turn_id !== undefined ? { turn_id: payload.turn_id } : {},
    });
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: dispatch,
    });
  });

  // ── Management channel ───────────────────────────────────────────

  router.registerMethod('session.getStatus', 'management', async (msg) => {
    const status = await sessionManager.getSessionStatus(msg.session_id);
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { state: status },
    });
  });

  router.registerMethod('session.getHistory', 'management', async (msg, _transport, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    const history = managed?.contextState.getHistory() ?? [];
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { messages: history as unknown as readonly unknown[] },
    });
  });

  router.registerMethod('session.subscribe', 'management', async (msg) => {
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  router.registerMethod('session.compact', 'management', async (msg) => {
    // Phase 9 stub — real compaction takes a provider + journal
    // capability which the harness doesn't wire. Return ok so tests
    // can assert the round-trip at the envelope level.
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  void createWireEvent; // retained for future event-producing handlers
}
