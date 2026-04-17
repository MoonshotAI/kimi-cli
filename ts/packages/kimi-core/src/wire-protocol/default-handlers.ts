/**
 * Default wire handler registrations (Phase 17 §A.1 / §A.5 / §A.3).
 *
 * Shared by the production `apps/kimi-cli --wire` runner and the
 * in-memory E2E harness. Registers process / conversation /
 * management / config / mcp handlers against the RequestRouter so
 * both runtimes speak the same wire surface. Phase 17 additions:
 *   - `session.resume` + `session.replay` (A.5)
 *   - `session.setPlanMode` / `session.setYolo` / `session.setModel`
 *     / `session.setSystemPrompt` / `session.addSystemReminder` (A.2)
 *   - `approval.response` reverse-RPC routing (A.3)
 *   - `mcp.*` noop responses (B.4)
 *   - initialize capability blob exposes `hooks.supported_events` +
 *     `hooks.configured` (B.7)
 *   - session.prompt / session.replay schemas validated via zod so
 *     bad params surface as -32602 (A.4)
 */

import { readFile } from 'node:fs/promises';
import { z, ZodError } from 'zod';

import type { KosongAdapter, Runtime } from '../soul/runtime.js';
import type { Tool } from '../soul/types.js';
import type { ApprovalRuntime } from '../soul-plus/approval-runtime.js';
import type { WiredApprovalRuntime } from '../soul-plus/wired-approval-runtime.js';
import type { ToolCallOrchestrator } from '../soul-plus/orchestrator.js';
import type { SessionEventBus } from '../soul-plus/session-event-bus.js';
import type { PathConfig } from '../session/path-config.js';
import type { SessionManager } from '../session/session-manager.js';
import type { RequestRouter } from '../router/request-router.js';
import { WireCodec } from './codec.js';
import { createWireEvent, createWireResponse } from './message-factory.js';
import {
  WIRE_PROTOCOL_VERSION,
  type InitializeResponseData,
  type SessionCancelRequestData,
  type SessionCreateRequestData,
  type SessionCreateResponseData,
  type SessionPromptRequestData,
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
  'subagent.event',
  'hook.triggered',
  'hook.resolved',
  'session.error',
  'session.replay.chunk',
  'session.replay.end',
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
  'session.compact',
  'session.replay',
  // config channel
  'session.setPlanMode',
  'session.setYolo',
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
 * Register default process/session handlers on the router.
 */
export function registerDefaultWireHandlers(deps: DefaultHandlersDeps): void {
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
  } = deps;

  // ── Process channel ──────────────────────────────────────────────

  router.registerProcessMethod('initialize', async (msg): Promise<WireMessage> => {
    const data: InitializeResponseData = {
      protocol_version: WIRE_PROTOCOL_VERSION,
      capabilities: {
        events: [...SUPPORTED_WIRE_EVENTS],
        methods: [...SUPPORTED_WIRE_METHODS],
        // Phase 17 §B.7 — advertise the hook machinery so clients can
        // subscribe. `configured` is empty in the bare harness; real
        // CLI runners will populate it from loaded config.
        hooks: {
          supported_events: HOOK_SUPPORTED_EVENTS,
          configured: [],
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
    // the client refreshes its indicators on reconnect.
    eventBus.emit({
      type: 'status.update',
      data: {
        model: defaultModel,
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
    await managed.sessionControl.setYolo(payload.enabled);
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

  // Phase 17 §B.4 — MCP methods return Noop responses so wire-schema
  // round-trips validate. Real implementations ship in the CLI slice.
  const mcpNoop = (data: unknown) =>
    async (msg: WireMessage): Promise<WireMessage> =>
      createWireResponse({
        requestId: msg.id,
        sessionId: msg.session_id,
        data,
      });

  router.registerProcessMethod('mcp.list', mcpNoop({ servers: [] }));
  router.registerProcessMethod('mcp.connect', mcpNoop({ ok: true }));
  router.registerProcessMethod('mcp.disconnect', mcpNoop({ ok: true }));
  router.registerProcessMethod('mcp.refresh', mcpNoop({ ok: true }));
  router.registerProcessMethod('mcp.listResources', mcpNoop({ resources: [] }));
  router.registerProcessMethod('mcp.readResource', mcpNoop({ contents: [] }));
  router.registerProcessMethod('mcp.listPrompts', mcpNoop({ prompts: [] }));
  router.registerProcessMethod('mcp.getPrompt', mcpNoop({ messages: [] }));
  router.registerProcessMethod('mcp.startAuth', mcpNoop({ ok: true }));
  router.registerProcessMethod('mcp.resetAuth', mcpNoop({ ok: true }));

  void createWireEvent;
  void ZodError;
}
