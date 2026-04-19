/**
 * Default wire handler registrations (Phase 17 §A / Phase 21 §A).
 *
 * Shared by the production `apps/kimi-cli --wire` runner and the
 * in-memory E2E harness. Registers process / conversation / management /
 * config / tools / mcp handlers against the RequestRouter so both
 * runtimes speak the same wire surface.
 *
 * Phase 17 additions:
 *   - `session.resume` + `session.replay` (§A.5)
 *   - `session.setPlanMode` / `session.setYolo` / `session.setModel` /
 *     `session.setSystemPrompt` / `session.addSystemReminder` (§A.2)
 *   - `approval.response` reverse-RPC routing (§A.3)
 *   - `mcp.*` noop responses (§B.4)
 *   - `initialize.capabilities` advertises `hooks.supported_events` +
 *     `hooks.configured` (§B.7)
 *   - session.prompt / session.replay schemas validated via zod so bad
 *     params surface as -32602 (§A.4)
 *
 * Phase 21 §A additions:
 *   - `session.setModel` accepts a host `rebuildRuntimeForModel` callback
 *     that owns the destroy+resume dance for live provider swaps.
 *   - `session.setThinking` emits a typed `thinking.changed` SoulEvent;
 *     the per-session WireEventBridge owns the wire `seq` (the previous
 *     direct send hardcoded `seq: 0`).
 *   - `session.subscribe` / `session.unsubscribe` actually mutate the
 *     per-session event filter (was a no-op stub). The filter is exposed
 *     via the returned `DefaultWireHandlersHandle.getEventFilter` so the
 *     WireEventBridge consults it on every emit.
 *   - `session.registerTool` rejects with a business error when no
 *     reverse-RPC channel is wired (was previously a silent `{ok:true}`
 *     even though invocations would dead-end).
 *   - WireHookExecutor wired against the shared HookEngine when
 *     `initialize.hooks[]` declares any matchers, so client hooks fan
 *     through `hook.request` reverse-RPC.
 *   - `registerDefaultWireHandlers` returns a handle so the host can
 *     plug per-session state (event filter for now) into the bridge.
 */

import { readFile } from 'node:fs/promises';
import { z } from 'zod';

import type { HookEngine } from '../hooks/engine.js';
import { WireHookExecutor, type WireHookSender } from '../hooks/wire-executor.js';
import type { HookEventType, WireHookConfig } from '../hooks/types.js';
import type { KosongAdapter, Runtime } from '../soul/runtime.js';
import type { Tool } from '../soul/types.js';
import type { ApprovalRuntime } from '../soul-plus/approval-runtime.js';
import type { WiredApprovalRuntime } from '../soul-plus/wired-approval-runtime.js';
import type { ApprovalStateStore } from '../soul-plus/approval-state-store.js';
import type { ToolCallOrchestrator } from '../soul-plus/orchestrator.js';
import type { SessionEventBus } from '../soul-plus/session-event-bus.js';
import type { McpRegistry } from '../soul-plus/mcp/registry.js';
import type { PathConfig } from '../session/path-config.js';
import type { SessionManager } from '../session/session-manager.js';
import { RequestRouter } from '../router/request-router.js';
import { SubagentStore } from '../soul-plus/subagent-store.js';
import type { BackgroundProcessManager } from '../tools/background/manager.js';
import type { Transport } from '../transport/types.js';
import { WireCodec } from './codec.js';
import { createWireEvent, createWireResponse } from './message-factory.js';
import {
  buildExternalToolProxy,
  createReverseRpcClient,
  createWireHookSender,
  getOrInitSessionState,
  type PerSessionStateMap,
  type ReverseRpcClient,
} from './reverse-rpc.js';
import {
  WIRE_PROTOCOL_VERSION,
  type InitializeResponseData,
  type SessionAddSystemReminderRequestData,
  type SessionCancelRequestData,
  type SessionCreateRequestData,
  type SessionCreateResponseData,
  type SessionPromptRequestData,
  type SessionRegisterToolRequestData,
  type SessionSetModelRequestData,
  type SessionSetThinkingRequestData,
  type SessionSteerRequestData,
  type WireMessage,
} from './types.js';

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
  readonly pathConfig: PathConfig;
  // Phase 18 §E.3-E.5 — optional; when missing the background-task
  // wire methods report an empty surface instead of 500-ing.
  readonly backgroundProcessManager?: BackgroundProcessManager | undefined;
  // Phase 21 §A — server transport used for reverse-RPC (`tool.call` /
  // `hook.request`) + `thinking.changed` broadcasts. Optional so unit
  // tests that don't exercise reverse paths can omit it.
  readonly server?: Transport | undefined;
  // Phase 21 §A — hook engine; required to register WireHookConfig
  // entries from `initialize.hooks[]` once reverse-RPC is available.
  readonly hookEngine?: HookEngine | undefined;
  // Phase 21 §A (B.2 parity) — persistent yolo store. When present,
  // `session.setYolo` delegates to it instead of flipping
  // `SessionControl.setYolo` directly.
  readonly approvalStateStore?: ApprovalStateStore | undefined;
  // Phase 24 Step 4.7 — real McpRegistry for mcp.list / mcp.refresh.
  // When absent, mcp.list returns {servers:[]} (backward compat).
  readonly mcpRegistry?: McpRegistry | undefined;
  // Phase 21 §A — `session.setModel` invokes this so the host can
  // rebuild the underlying Provider/Kosong adapter (live-switch). The
  // handler awaits the callback before invoking `SoulPlus.setModel` so
  // the journal records the new model only after the swap succeeds.
  // When absent, `setModel` is a metadata-only flip (parity with the
  // test harness behaviour).
  readonly rebuildRuntimeForModel?:
    | ((sessionId: string, model: string) => Promise<void> | void)
    | undefined;
  // Phase 21 review hotfix — `rebuildRuntimeForModel` mutates the host's
  // runtime/model selection, but `deps.runtime` / `deps.defaultModel`
  // are destructured once at registration time. `session.create` /
  // `session.resume` fired after a live model-switch would therefore
  // reach for the stale snapshot. These optional providers let the
  // host expose live accessors; handlers prefer them when present.
  readonly runtimeProvider?: (() => Runtime) | undefined;
  readonly defaultModelProvider?: (() => string) | undefined;
  // Phase 21 §A — hook reverse-RPC timeout. Defaults to 30s.
  readonly hookTimeoutMs?: number | undefined;
}

// Phase 17 §B.7 — the 13 HookEvent types registered under
// `hooks.supported_events` in initialize capabilities.
const HOOK_SUPPORTED_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'OnToolFailure',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
  'PreCompact',
  'PostCompact',
] as const;

// Phase 17 — keep `initialize.capabilities.events` / `.methods`
// co-located with the handler registrations below so a newly
// registered method (or a newly emitted event in event-bridge.ts)
// gets a single source of truth. These arrays MUST be updated in
// lock-step with the `router.register*` calls — the test in
// `test/wire-protocol/initialize-capabilities.test.ts` (if/when it
// lands) pins the invariant.
const SUPPORTED_WIRE_EVENTS = [
  'turn.begin',
  'turn.end',
  'step.begin',
  'step.end',
  'step.interrupted',
  'content.delta',
  'tool.call',
  'tool.call.delta',
  'tool.progress',
  'tool.result',
  'status.update',
  'compaction.begin',
  'compaction.end',
  'notification',
  'hook.triggered',
  'hook.resolved',
  'session.error',
  'session.replay.chunk',
  'session.replay.end',
  // Phase 21 §A — typed thinking-level change forwarded by the bridge.
  'thinking.changed',
  // Phase 24 — skill lifecycle events (Step 3).
  'skill.invoked',
  'skill.completed',
  // Phase 24 — MCP server lifecycle events (Step 4).
  'mcp.loading',
  'mcp.connected',
  'mcp.disconnected',
  'mcp.error',
  'mcp.tools_changed',
  'mcp.resources_changed',
  'mcp.auth_required',
  // Phase 24 — MCP status update variant.
  'status.update.mcp_status',
  // Phase 16 — session meta changes forwarded by the bridge.
  'session_meta.changed',
] as const;

const SUPPORTED_WIRE_METHODS = [
  // process channel
  'initialize',
  'session.create',
  'session.list',
  'session.destroy',
  'shutdown',
  // mcp.* (noop responders in Phase 17 — real wiring in CLI Phase)
  'mcp.list',
  'mcp.connect',
  'mcp.disconnect',
  'mcp.refresh',
  'mcp.listResources',
  'mcp.readResource',
  'mcp.listPrompts',
  'mcp.getPrompt',
  'mcp.startAuth',
  'mcp.resetAuth',
  // conversation channel
  'session.prompt',
  'session.steer',
  'session.cancel',
  'session.resume',
  'approval.response',
  // management channel
  'session.getStatus',
  'session.getHistory',
  'session.subscribe',
  'session.unsubscribe',
  'session.compact',
  'session.clear',
  'session.replay',
  // Phase 18 §E.3-E.5 + §F — background tasks / rollback / skills.
  'session.getBackgroundTasks',
  'session.stopBackgroundTask',
  'session.getBackgroundTaskOutput',
  'session.rollback',
  'session.listSkills',
  'session.activateSkill',
  // config channel
  'session.setPlanMode',
  'session.setYolo',
  'session.setModel',
  'session.setThinking',
  'session.addSystemReminder',
  // tools channel (Phase 18 §A.8 / §A.9 — dynamic tool management)
  'session.registerTool',
  'session.removeTool',
  'session.listTools',
  'session.setActiveTools',
] as const;

// Phase 17 §A.4 — zod schemas used at handler entry points. Rejecting
// bad input at this seam produces a ZodError → -32602 via
// `mapToWireError`.
const UserInputPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({ url: z.string() }),
  }),
  z.object({
    type: z.literal('video_url'),
    video_url: z.object({ url: z.string() }),
  }),
]);

const SessionPromptSchema = z.object({
  input: z.union([z.string(), z.array(UserInputPartSchema)]),
  input_kind: z.enum(['user', 'system_trigger']).optional(),
  trigger_source: z.string().optional(),
});

const SessionReplaySchema = z.object({
  from_seq: z.number().int().nonnegative().optional(),
});

const ApprovalResponseSchema = z.object({
  request_id: z.string().min(1),
  response: z.enum(['approved', 'rejected', 'cancelled']),
  feedback: z.string().optional(),
  scope: z.literal('session').optional(),
});

/**
 * Handle returned from `registerDefaultWireHandlers` so callers can plug
 * the per-session event filter (populated by `session.subscribe`) into a
 * per-session WireEventBridge. Returning a thin object instead of raw
 * `perSession` keeps the internal map encapsulated.
 */
export interface DefaultWireHandlersHandle {
  /**
   * Returns the active event filter for `sessionId`, or `undefined` when
   * no filter has been installed (i.e. the client is subscribed to the
   * default "all events" set).
   */
  readonly getEventFilter: (sessionId: string) => ReadonlySet<string> | undefined;
}

/**
 * Register default process/session handlers on the router.
 */
export function registerDefaultWireHandlers(
  deps: DefaultHandlersDeps,
): DefaultWireHandlersHandle {
  const {
    router,
    sessionManager,
    runtime,
    tools,
    eventBus,
    workspaceDir,
    defaultModel,
    orchestrator,
    approval,
    pathConfig,
    backgroundProcessManager,
    server,
    hookEngine,
    approvalStateStore,
    rebuildRuntimeForModel,
    hookTimeoutMs,
    mcpRegistry,
  } = deps;

  // Phase 21 §A — per-session mutable state for the new wire methods.
  // Tracks external tool registrations, the active-tool narrowing list,
  // and the event-fan-out subscription filter. Created lazily on first
  // touch by `getOrInitSessionState`.
  const perSession: PerSessionStateMap = new Map();

  // Phase 21 §A — reverse-RPC client (core→client). Available only when
  // a server transport is wired. Used by `session.registerTool` to
  // build external tool proxies and by the WireHookExecutor below.
  const reverse: ReverseRpcClient | undefined = server !== undefined
    ? createReverseRpcClient({ server, router })
    : undefined;

  // Phase 21 §A — captured `initialize.hooks[]` so WireHookConfig
  // entries can be registered against the shared HookEngine once
  // reverse-RPC is available. The caller passes the latest session id
  // through `sessionIdResolver` so hook executors target the right
  // session (production runs typically have one live session at a time).
  let initialHooks: ReadonlyArray<{
    event: string;
    matcher?: unknown;
    id?: string;
  }> = [];

  // ── Process channel ──────────────────────────────────────────────

  router.registerProcessMethod('initialize', async (msg): Promise<WireMessage> => {
    const payload = (msg.data ?? {}) as {
      hooks?: ReadonlyArray<{ event: string; matcher?: unknown; id?: string }>;
    };
    initialHooks = payload.hooks ?? [];

    // Register a WireHookExecutor on the shared HookEngine so the
    // configured hooks can dispatch via `hook.request` reverse-RPC.
    if (hookEngine !== undefined && reverse !== undefined && initialHooks.length > 0) {
      const sender: WireHookSender = {
        async send(message) {
          const sid = [...perSession.keys()][0] ?? msg.session_id;
          const inner = createWireHookSender({
            reverse,
            sessionId: sid,
            hookTimeoutMs: hookTimeoutMs ?? 30_000,
          });
          return inner.send(message);
        },
      };
      hookEngine.registerExecutor('wire', new WireHookExecutor(sender));
      for (const entry of initialHooks) {
        const cfg: WireHookConfig = {
          type: 'wire',
          event: entry.event as HookEventType,
          ...(typeof entry.matcher === 'string' ? { matcher: entry.matcher } : {}),
          subscriptionId:
            entry.id ?? `hk_${entry.event}_${Math.random().toString(36).slice(2, 8)}`,
        };
        hookEngine.register(cfg);
      }
    }

    const data: InitializeResponseData = {
      protocol_version: WIRE_PROTOCOL_VERSION,
      capabilities: {
        events: [...SUPPORTED_WIRE_EVENTS],
        methods: [...SUPPORTED_WIRE_METHODS],
        hooks: {
          supported_events: HOOK_SUPPORTED_EVENTS,
          configured: initialHooks.map((h) => ({
            event: h.event,
            ...(typeof h.matcher === 'string' && h.matcher.length > 0
              ? { matcher: h.matcher }
              : {}),
          })),
        },
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
    // Phase 21 review hotfix — prefer live provider over the snapshot
    // captured when the handler was registered so new sessions pick up
    // the latest runtime/model after `session.setModel` fired.
    const liveRuntime = deps.runtimeProvider?.() ?? runtime;
    const liveDefaultModel = deps.defaultModelProvider?.() ?? defaultModel;
    const managed = await sessionManager.createSession({
      ...(payload.session_id !== undefined ? { sessionId: payload.session_id } : {}),
      runtime: liveRuntime,
      tools,
      model: payload.model ?? liveDefaultModel,
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
    // Phase 17 §A.4 — validate input via zod so non-string/non-array
    // payloads surface as -32602 instead of internal errors.
    const payload = SessionPromptSchema.parse(msg.data ?? {}) as SessionPromptRequestData;
    let inputText: string;
    let inputParts:
      | readonly import('./types.js').UserInputPart[]
      | undefined;
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
      data: dispatch,
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

  // Phase 17 §A.5 — `session.resume` returns a snapshot of the live
  // session (turn count + last turn id). Emits a fresh
  // `status.update` so the client's stale model/plan_mode indicator
  // refreshes on reconnect.
  router.registerMethod('session.resume', 'conversation', async (msg, _transport, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);

    // Count turn_begin records to derive turn_count + last_turn_id.
    // Read on-disk wire.jsonl (tests flush via `journalWriter.flush()`
    // before resuming).
    const wirePath = pathConfig.wirePath(msg.session_id);
    let turnCount = 0;
    let lastTurnId: string | undefined;
    try {
      const content = await readFile(wirePath, 'utf8');
      const bodyLines = content
        .split('\n')
        .filter((l) => l.length > 0)
        .slice(1);
      for (const line of bodyLines) {
        try {
          const rec = JSON.parse(line) as { type?: string; turn_id?: string };
          if (rec.type === 'turn_begin') {
            turnCount += 1;
            if (rec.turn_id !== undefined) lastTurnId = rec.turn_id;
          }
        } catch {
          /* skip malformed line */
        }
      }
    } catch {
      /* wire.jsonl missing → fresh session; counts stay 0/undefined */
    }

    // Emit status.update snapshot with current model + plan-mode so
    // the client refreshes its indicators on reconnect. Use the live
    // provider (Phase 21 review hotfix) so a post-setModel resume
    // surfaces the new alias, not the boot-time default.
    eventBus.emit({
      type: 'status.update',
      data: {
        model: deps.defaultModelProvider?.() ?? defaultModel,
        plan_mode: managed.soulPlus.getTurnManager().getPlanMode(),
      },
    });

    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: {
        session_id: msg.session_id,
        turn_count: turnCount,
        ...(lastTurnId !== undefined ? { last_turn_id: lastTurnId } : {}),
      },
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
      data: { messages: history },
    });
  });

  // Phase 21 §A — `session.subscribe` actually narrows the per-session
  // event-fan-out filter (was a no-op stub). The companion
  // `session.unsubscribe` handler clears the filter. The WireEventBridge
  // looks the filter up via the handle returned from
  // `registerDefaultWireHandlers` (`getEventFilter(sessionId)`), so any
  // mutation here is observed on the next emit without re-installing the
  // bridge.
  router.registerMethod('session.subscribe', 'management', async (msg) => {
    const payload = (msg.data ?? {}) as { events?: unknown };
    const state = getOrInitSessionState(perSession, msg.session_id);
    if (Array.isArray(payload.events)) {
      const events = payload.events.filter((e): e is string => typeof e === 'string');
      state.eventFilter = events.length > 0 ? new Set(events) : undefined;
    } else {
      state.eventFilter = undefined;
    }
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  router.registerMethod('session.compact', 'management', async (msg) => {
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  router.registerMethod('session.clear', 'management', async (msg, _t, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    await managed.sessionControl.clear();
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  // Phase 17 §A.5 — `session.replay` streams the session's wire.jsonl
  // body records as chunked reply frames followed by a terminating
  // `session.replay.end`.
  router.registerMethod('session.replay', 'management', async (msg, transport, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const payload = SessionReplaySchema.parse(msg.data ?? {});
    const fromSeq = payload.from_seq ?? 0;

    // Read wire.jsonl body lines. First line is the metadata header,
    // skip it.
    void managed;
    const wirePath = pathConfig.wirePath(msg.session_id);
    let body: unknown[] = [];
    try {
      const content = await readFile(wirePath, 'utf8');
      const lines = content.split('\n').filter((l) => l.length > 0);
      body = lines.slice(1).flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    } catch {
      // Missing wire.jsonl → empty replay.
    }

    const filtered = body.filter((r: unknown) => {
      const seq = (r as { seq?: number }).seq;
      return seq === undefined || seq >= fromSeq;
    });

    // Phase 17 §A.5 — stream chunks as proper WireEvents (type='event',
    // auto-assigned seq, correlation back to the replay request via
    // request_id) so clients can route them through the normal event
    // path instead of peeking at `method` on a response envelope.
    const codec = new WireCodec();
    let replaySeq = 0;
    const CHUNK_SIZE = 20;
    for (let i = 0; i < filtered.length; i += CHUNK_SIZE) {
      const records = filtered.slice(i, i + CHUNK_SIZE);
      const chunkFrame = createWireEvent({
        method: 'session.replay.chunk',
        sessionId: msg.session_id,
        seq: replaySeq++,
        requestId: msg.id,
        data: { records },
      });
      await transport.send(codec.encode(chunkFrame));
    }

    const endFrame = createWireEvent({
      method: 'session.replay.end',
      sessionId: msg.session_id,
      seq: replaySeq,
      requestId: msg.id,
      data: { total: filtered.length },
    });
    await transport.send(codec.encode(endFrame));

    // Router still needs a nominal response to close out the pending
    // request on the client side.
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true, total: filtered.length },
    });
  });

  // ── Phase 18 §E.3 — session.getBackgroundTasks ───────────────────
  //
  // Returns the union of live BPM entries and persisted subagent
  // instance records. `agent_instances` keeps the slice 18-3 field
  // name (`subagent_type`) aligned with Python; the phase-18 todo's
  // `agent_type` was itself divergent and we retain the Python
  // convention (see completion-report deviation log).

  router.registerMethod('session.getBackgroundTasks', 'management', async (msg) => {
    const backgroundTasks = backgroundProcessManager?.list() ?? [];
    const store = new SubagentStore(pathConfig.sessionDir(msg.session_id));
    // `SubagentStore.listInstances()` swallows ENOENT internally, so a
    // fresh session with no `subagents/` dir surfaces as `[]`.
    const agentInstances = await store.listInstances();
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: {
        background_tasks: backgroundTasks,
        agent_instances: agentInstances,
      },
    });
  });

  // ── Phase 18 §E.4 — session.stopBackgroundTask ───────────────────

  router.registerMethod('session.stopBackgroundTask', 'management', async (msg) => {
    const payload = z
      .object({ task_id: z.string().min(1) })
      .parse(msg.data ?? {});
    if (backgroundProcessManager === undefined) {
      throw new Error(
        `session.stopBackgroundTask: no BackgroundProcessManager wired (task ${payload.task_id})`,
      );
    }
    const stopped = await backgroundProcessManager.stop(payload.task_id);
    if (stopped === undefined) {
      throw new Error(`Background task not found: ${payload.task_id}`);
    }
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  // ── Phase 18 §E.5 — session.getBackgroundTaskOutput ──────────────

  router.registerMethod('session.getBackgroundTaskOutput', 'management', async (msg) => {
    const payload = z
      .object({
        task_id: z.string().min(1),
        tail: z.number().int().nonnegative().optional(),
      })
      .parse(msg.data ?? {});
    if (backgroundProcessManager === undefined) {
      return createWireResponse({
        requestId: msg.id,
        sessionId: msg.session_id,
        data: { output: '' },
      });
    }
    const output = backgroundProcessManager.getOutput(payload.task_id, payload.tail);
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { output },
    });
  });

  // ── Phase 18 §F.1 — session.rollback ─────────────────────────────

  router.registerMethod('session.rollback', 'management', async (msg) => {
    const payload = z
      .object({ n_turns_back: z.number().int().nonnegative() })
      .parse(msg.data ?? {});
    const result = await sessionManager.rollbackSession(
      msg.session_id,
      payload.n_turns_back,
    );
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { new_turn_count: result.new_turn_count },
    });
  });

  // ── Phase 18 §F.2 — session.listSkills ───────────────────────────

  router.registerMethod('session.listSkills', 'management', async (msg, _t, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const skillManager = managed.soulPlus.getSkillManager();
    const skills = skillManager?.listInvocableSkills() ?? [];
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { skills },
    });
  });

  // ── Phase 18 §F.3 — session.activateSkill ────────────────────────

  router.registerMethod('session.activateSkill', 'management', async (msg, _t, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const payload = z
      .object({
        name: z.string().min(1),
        args: z.string().optional(),
      })
      .parse(msg.data ?? {});
    await managed.soulPlus.activateSkill(payload.name, payload.args ?? '');
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  // ── Config channel ───────────────────────────────────────────────

  router.registerMethod('session.setPlanMode', 'config', async (msg, _t, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const payload = z.object({ enabled: z.boolean() }).parse(msg.data ?? {});
    await managed.sessionControl.setPlanMode(payload.enabled);
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  router.registerMethod('session.setYolo', 'config', async (msg, _t, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const payload = z.object({ enabled: z.boolean() }).parse(msg.data ?? {});
    // Order matters: sessionControl.setYolo writes the wire record and flips
    // TurnManager.permissionMode synchronously. Calling store.setYolo after this
    // makes the onChanged listener's setPermissionMode idempotent (oldMode === newMode
    // short-circuits), so we don't double-write. If order were reversed, the listener
    // would flip TurnManager first, then sessionControl.setYolo would see previousMode
    // === newMode and skip appendPermissionModeChanged, losing the wire record.
    await managed.sessionControl.setYolo(payload.enabled);
    if (approvalStateStore !== undefined) {
      await approvalStateStore.setYolo(payload.enabled);
    }
    // Phase 21 §A — emit a status.update so observers pick up the yolo
    // change (parity with test-helper handler).
    managed.soulPlus.getTurnManager().emitStatusUpdate({ input: 0, output: 0 });
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  // ── Phase 21 §A — session.setModel / setThinking / addSystemReminder ──

  router.registerMethod('session.setModel', 'config', async (msg, _t, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const payload = (msg.data ?? {}) as Partial<SessionSetModelRequestData>;
    if (typeof payload.model !== 'string' || payload.model.length === 0) {
      throw new Error('invalid params: model must be a non-empty string');
    }
    // Phase 21 §A — when the host wires `rebuildRuntimeForModel`, the
    // callback owns the full live-switch dance (rebuild Provider/Kosong
    // adapter → destroy + resume the session → journal the model change
    // on the resumed SoulPlus). The current `managed` reference becomes
    // stale after that, so we MUST NOT call `managed.soulPlus.setModel`
    // here — that would write to a torn-down journal. The fallback path
    // (no `rebuildRuntimeForModel`, e.g. unit tests / harness) keeps the
    // metadata-only flip semantics on the live SoulPlus.
    if (rebuildRuntimeForModel !== undefined) {
      await rebuildRuntimeForModel(msg.session_id, payload.model);
    } else {
      await managed.soulPlus.setModel(payload.model);
    }
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  router.registerMethod('session.setThinking', 'config', async (msg, _t, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const payload = (msg.data ?? {}) as Partial<SessionSetThinkingRequestData>;
    if (typeof payload.level !== 'string') {
      throw new Error('invalid params: level must be a string');
    }
    // Phase 21 §A — `setThinking` now emits a `thinking.changed` SoulEvent
    // via the bus; the per-session WireEventBridge owns the `seq` counter
    // and translates it into the wire event. The previous `seq: 0` direct
    // send collided whenever a client flipped `thinking` more than once
    // before the next turn.
    await managed.soulPlus.setThinking(payload.level);
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  router.registerMethod('session.addSystemReminder', 'config', async (msg, _t, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const payload = (msg.data ?? {}) as Partial<SessionAddSystemReminderRequestData>;
    if (typeof payload.content !== 'string' || payload.content.length === 0) {
      throw new Error('invalid params: content must be a non-empty string');
    }
    await managed.soulPlus.addSystemReminder(payload.content);
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  // ── Phase 21 §A — session.unsubscribe (event filter clear) ───────

  router.registerMethod('session.unsubscribe', 'management', async (msg) => {
    const state = getOrInitSessionState(perSession, msg.session_id);
    state.eventFilter = undefined;
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  // ── Phase 21 §A — dynamic tool management (tools channel) ────────

  router.registerMethod('session.registerTool', 'tools', async (msg, _t, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const payload = (msg.data ?? {}) as Partial<SessionRegisterToolRequestData>;
    if (typeof payload.name !== 'string' || payload.name.length === 0) {
      throw new Error('invalid params: name must be a non-empty string');
    }
    // Phase 21 §A — `session.registerTool` is meaningless without a
    // reverse-RPC channel: the registered tool would be advertised on the
    // schema, picked up by Soul, but every invocation would dead-end at a
    // missing `tool.call` sender. Reject early instead of silently
    // succeeding (was the pre-fix behaviour) so the caller can react to
    // the misconfiguration on the request that introduced it. The check
    // also runs before the perSession mutation so `listTools` and the
    // SoulPlus dynamic registry stay in lockstep with what's invocable.
    if (reverse === undefined) {
      throw new Error(
        'session.registerTool requires a reverse-RPC channel (no `server` transport wired)',
      );
    }
    const state = getOrInitSessionState(perSession, msg.session_id);
    state.externalTools.set(payload.name, {
      description: payload.description ?? '',
      input_schema: payload.input_schema,
    });
    await managed.soulPlus.registerDynamicTool(
      buildExternalToolProxy({
        name: payload.name,
        description: payload.description ?? '',
        inputSchema: payload.input_schema,
        sendToolCall: async (call, signal) => {
          const response = await reverse.sendRequest(
            'tool.call',
            managed.sessionId,
            { id: call.id, name: call.name, args: call.args },
            { timeoutMs: 30_000, signal },
          );
          const data = (response.data ?? {}) as {
            output?: string;
            is_error?: boolean;
          };
          return {
            output: data.output ?? '',
            ...(data.is_error !== undefined ? { is_error: data.is_error } : {}),
          };
        },
      }),
    );
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  router.registerMethod('session.removeTool', 'tools', async (msg, _t, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const payload = (msg.data ?? {}) as { name?: string };
    if (typeof payload.name !== 'string') {
      throw new Error('invalid params: name must be a string');
    }
    const state = getOrInitSessionState(perSession, msg.session_id);
    state.externalTools.delete(payload.name);
    await managed.soulPlus.removeDynamicTool(payload.name);
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  router.registerMethod('session.listTools', 'tools', async (msg, _t, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const state = getOrInitSessionState(perSession, msg.session_id);
    const allTools = managed.soulPlus.getTools();
    const activeSet =
      state.activeToolNames === undefined ? undefined : new Set(state.activeToolNames);
    const serialised = allTools.map((t) => ({
      name: t.name,
      description: t.description,
      active: activeSet === undefined ? true : activeSet.has(t.name),
    }));
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: {
        tools: serialised,
        ...(state.activeToolNames !== undefined
          ? { active: [...state.activeToolNames] }
          : {}),
      },
    });
  });

  router.registerMethod('session.setActiveTools', 'tools', async (msg, _t, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const payload = (msg.data ?? {}) as { names?: string[] };
    if (!Array.isArray(payload.names)) {
      throw new Error('invalid params: names must be an array');
    }
    const state = getOrInitSessionState(perSession, msg.session_id);
    state.activeToolNames = [...payload.names];
    await managed.soulPlus.setActiveTools(payload.names);
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  // Phase 17 §A.3 — `approval.response` reverse-RPC land-in. Client
  // echoes the original frame's `session_id`, so this is a
  // session-level (conversation channel) handler — process-level
  // registration would miss all non-`__process__` ids. The runtime
  // itself routes by `data.request_id`; the handler only needs the
  // `approval` closure variable.
  router.registerMethod(
    'approval.response',
    'conversation',
    async (msg): Promise<WireMessage> => {
      const payload = ApprovalResponseSchema.parse(msg.data ?? {});
      try {
        (approval as WiredApprovalRuntime).resolveRemote({
          request_id: payload.request_id,
          response: payload.response,
          ...(payload.feedback !== undefined ? { feedback: payload.feedback } : {}),
          ...(payload.scope !== undefined ? { scope: payload.scope } : {}),
        });
      } catch {
        /* swallow — stub approval runtimes may not implement resolveRemote */
      }
      return createWireResponse({
        requestId: msg.id,
        sessionId: msg.session_id,
        data: { ok: true },
      });
    },
  );

  // Phase 24 Step 4.7 — mcp.list and mcp.refresh connected to real McpRegistry.
  // Other MCP methods remain noop stubs (D4-4).
  const mcpNoop = (data: unknown) =>
    async (msg: WireMessage): Promise<WireMessage> =>
      createWireResponse({
        requestId: msg.id,
        sessionId: msg.session_id,
        data,
      });

  router.registerProcessMethod('mcp.list', async (msg) => {
    const snap = mcpRegistry?.status() ?? { servers: [] };
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { servers: snap.servers },
    });
  });

  router.registerProcessMethod('mcp.refresh', async (msg) => {
    const data = msg.data as { server_id?: string } | undefined;
    if (mcpRegistry !== undefined && data?.server_id !== undefined) {
      await mcpRegistry.refresh(data.server_id);
    }
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  router.registerProcessMethod('mcp.connect', mcpNoop({ ok: true }));
  router.registerProcessMethod('mcp.disconnect', mcpNoop({ ok: true }));
  router.registerProcessMethod('mcp.listResources', mcpNoop({ resources: [] }));
  router.registerProcessMethod('mcp.readResource', mcpNoop({ contents: [] }));
  router.registerProcessMethod('mcp.listPrompts', mcpNoop({ prompts: [] }));
  router.registerProcessMethod('mcp.getPrompt', mcpNoop({ messages: [] }));
  router.registerProcessMethod('mcp.startAuth', mcpNoop({ ok: true }));
  router.registerProcessMethod('mcp.resetAuth', mcpNoop({ ok: true }));

  void createWireEvent;

  return {
    getEventFilter: (sessionId: string): ReadonlySet<string> | undefined =>
      perSession.get(sessionId)?.eventFilter,
  };
}

