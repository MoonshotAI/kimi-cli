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
 * NOTE: ts-rewrite-work introduced a parallel production-style
 * registration at `src/wire-protocol/default-handlers.ts`. That file
 * implements a subset of the handlers here (setPlanMode / setYolo /
 * resume / replay / mcp.* / approval.response). This test helper
 * remains the full set (A.1-A.14 + Phase 18 alignment) for tests
 * that require the complete Phase 18 surface. Phase 11 will
 * consolidate.
 *
 * The handlers mirror the contracts in `src/wire-protocol/types.ts`
 * (process / conversation / management / config channels) and
 * delegate to the real `SessionManager` + `SoulPlus` where possible.
 * `from` / `to` envelope fields are faithful but opaque — Phase 10
 * may override individual handlers via `routerOverrides`.
 *
 * Phase 18 Section A (this slice) adds:
 *   - initialize.external_tools conflict detection (A.1)
 *   - tool.call reverse-RPC proxies for external tools (A.2)
 *   - session config setters: setModel / setPlanMode / setYolo /
 *     setThinking / addSystemReminder (A.3–A.7)
 *   - dynamic tool management: registerTool / removeTool / listTools /
 *     setActiveTools (A.8)
 *   - session.subscribe / unsubscribe event filtering (A.9)
 *   - hook.request reverse-RPC (A.10)
 *   - -32001 / -32002 / -32003 business error codes (A.11–A.13)
 *   - status.update event forwarding carrying context_usage.percent
 *     (A.14) — already emitted by TurnManager; this module just
 *     bridges it to the wire.
 */
/* oxlint-disable import/max-dependencies */

import type { HookEngine } from '../../../src/hooks/engine.js';
import type { RequestRouter } from '../../../src/router/request-router.js';
import type { SessionManager } from '../../../src/session/session-manager.js';
import type { ApprovalStateStore } from '../../../src/soul-plus/approval-state-store.js';
import type { ApprovalRuntime } from '../../../src/soul-plus/approval-runtime.js';
import type { ToolCallOrchestrator } from '../../../src/soul-plus/orchestrator.js';
import type { SessionEventBus } from '../../../src/soul-plus/session-event-bus.js';
import { SubagentStore } from '../../../src/soul-plus/subagent-store.js';
import type { DispatchResponse } from '../../../src/soul-plus/types.js';
import type { KosongAdapter, Runtime } from '../../../src/soul/runtime.js';
import type { Tool } from '../../../src/soul/types.js';
import type { MemoryTransport } from '../../../src/transport/memory-transport.js';
import {
  createWireEvent,
  createWireResponse,
} from '../../../src/wire-protocol/message-factory.js';
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
  type SessionSetPlanModeRequestData,
  type SessionSetThinkingRequestData,
  type SessionSetYoloRequestData,
  type SessionSteerRequestData,
  type UserInputPart,
  type WireMessage,
} from '../../../src/wire-protocol/types.js';
import { z } from 'zod';
import {
  buildExternalToolProxy,
  classifyBusinessError,
  checkLLMCapabilities,
  createReverseRpcClient,
  getOrInitSessionState,
  installHarnessWireEventBridge,
  registerWireHooks,
  resolveExternalTools,
  type PerSessionStateMap,
} from './phase18-extensions.js';

/**
 * Phase 18 A.10 — create a local no-op Tool for the given name.
 * Used when `initialize.hooks[].matcher` references a tool that isn't
 * in the builtin registry; Soul's `findTool` would otherwise
 * short-circuit before the PreToolUse hook can fire. The stub accepts
 * any args and returns an empty output so the test can observe the
 * hook.request reverse-RPC without a real tool implementation.
 */
function makeLocalStubTool(name: string): Tool<unknown, unknown> {
  return {
    name,
    description: `stub tool registered via initialize.hooks for ${name}`,
    inputSchema: z.unknown(),
    async execute(): Promise<import('../../../src/soul/types.js').ToolResult<unknown>> {
      return { content: '', output: '' };
    },
  };
}

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
  /**
   * Phase 18 — harness-side server transport for auto-installed wire
   * event bridging + reverse-RPC (`tool.call` / `hook.request`).
   */
  readonly server?: MemoryTransport | undefined;
  /**
   * Phase 18 A.10 — optional hook engine to register `WireHookConfig`
   * entries parsed from `initialize.hooks[]`.
   */
  readonly hookEngine?: HookEngine | undefined;
  /**
   * Phase 18 B.2 — optional approval state store used by
   * `session.setYolo` to delegate to `setYolo` + `onChanged`. When
   * absent, setYolo falls back to `SessionControl.setYolo` (which flips
   * permission_mode).
   */
  readonly approvalStateStore?: ApprovalStateStore | undefined;
  /**
   * Phase 17 A.5 — optional path config used by `session.resume` /
   * `session.replay` to locate the session's `wire.jsonl`. When
   * omitted those handlers are not registered.
   */
  readonly pathConfig?: import('../../../src/session/path-config.js').PathConfig | undefined;
}

/**
 * Register default process/session handlers on the router.
 */
export function registerDefaultWireHandlers(deps: DefaultHandlersDeps): void {
  const {
    router,
    sessionManager,
    runtime,
    tools: builtinTools,
    eventBus,
    workspaceDir,
    defaultModel,
    orchestrator,
    server,
    hookEngine,
    approvalStateStore,
    pathConfig,
  } = deps;

  /**
   * Per-session mutable state — external tools, active filter, event
   * subscription filter, bridge disposer. Created lazily in
   * `session.create`; read by later session-scoped handlers.
   */
  const perSession: PerSessionStateMap = new Map();

  /**
   * Phase 18 A.1 — holds the most recent client-supplied external
   * tools list (from initialize). Applied when a session is created
   * so each session starts with the declared external tools
   * pre-registered.
   */
  let initialExternalTools: Array<{
    name: string;
    description: string;
    input_schema: unknown;
  }> = [];

  /**
   * Phase 18 A.10 — hooks list from initialize. Turned into
   * WireHookConfig entries on the shared HookEngine once reverse-RPC
   * is available.
   */
  let initialHooks: ReadonlyArray<{
    event: string;
    matcher?: unknown;
    id?: string;
  }> = [];

  const reverse = server !== undefined
    ? createReverseRpcClient({ server, router })
    : undefined;

  // ── Process channel ──────────────────────────────────────────────

  router.registerProcessMethod('initialize', async (msg): Promise<WireMessage> => {
    const payload = (msg.data ?? {}) as {
      protocol_version?: string;
      capabilities?: Record<string, unknown>;
      hooks?: ReadonlyArray<{ event: string; matcher?: unknown; id?: string }>;
      client_capabilities?: {
        external_tools?: ReadonlyArray<{
          name: string;
          description?: string;
          parameters?: unknown;
          input_schema?: unknown;
        }>;
      };
    };
    const externalTools = payload.client_capabilities?.external_tools ?? [];
    const { resolution, accepted } = resolveExternalTools(externalTools, builtinTools);
    initialExternalTools = accepted;
    initialHooks = payload.hooks ?? [];

    // Phase 18 A.10 — register wire hooks when hookEngine + reverse
    // RPC are both available. Hook subscription id is not
    // session-scoped (HookEngine spans all sessions in the harness);
    // the executor resolves the current session id per invocation via
    // a closure over the single-session harness state.
    if (hookEngine !== undefined && reverse !== undefined && initialHooks.length > 0) {
      registerWireHooks({
        hookEngine,
        hooks: initialHooks,
        reverse,
        sessionIdResolver: () => {
          const first = [...perSession.keys()][0];
          return first ?? '__process__';
        },
      });
    }

    const data: InitializeResponseData & {
      external_tools?: { accepted: string[]; rejected: Array<{ name: string; reason: string }> };
    } = {
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
          'model.changed',
          'thinking.changed',
          'hook.triggered',
          'hook.resolved',
        ],
        methods: [
          'initialize',
          'session.create',
          'session.list',
          'session.destroy',
          'session.prompt',
          'session.steer',
          'session.cancel',
          'session.resume',
          'session.replay',
          'session.getStatus',
          'session.getHistory',
          'session.subscribe',
          'session.unsubscribe',
          'session.compact',
          'session.clear',
          'session.setModel',
          'session.setPlanMode',
          'session.setYolo',
          'session.setThinking',
          'session.addSystemReminder',
          'session.registerTool',
          'session.removeTool',
          'session.listTools',
          'session.setActiveTools',
          'shutdown',
        ],
        // Phase 17 B.7 — initialize capability blob publishes the 13
        // supported hook event types + any pre-declared subscriptions.
        // Sits inside `capabilities.hooks` so clients can discover what
        // the server understands before wiring reverse-RPC hook handlers.
        hooks: {
          supported_events: [
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
          ],
          configured: initialHooks.map((h) => ({
            event: h.event,
            ...(h.matcher !== undefined ? { matcher: h.matcher } : {}),
          })),
        },
      } as InitializeResponseData['capabilities'] & {
        hooks: {
          supported_events: string[];
          configured: Array<{ event: string; matcher?: string }>;
        };
      },
      // Phase 18 A.1 — top-level external_tools summary. Lives on the
      // response `data`, not inside `capabilities`, so the client can
      // read rejected conflicts without drilling into capability flags.
      external_tools: {
        accepted: resolution.accepted,
        rejected: resolution.rejected,
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
    const modelName = payload.model ?? defaultModel;

    // Phase 18 A.11 — -32001 LLM not set. Surface at session.create so
    // the client learns immediately instead of only at prompt time.
    if (modelName === undefined || modelName === '') {
      return createWireResponse({
        requestId: msg.id,
        sessionId: msg.session_id,
        error: {
          code: -32001,
          message: 'No default LLM configured. Set a model before creating a session.',
        },
      });
    }

    const managed = await sessionManager.createSession({
      ...(payload.session_id !== undefined ? { sessionId: payload.session_id } : {}),
      runtime,
      tools: builtinTools,
      model: modelName,
      ...(payload.system_prompt !== undefined ? { systemPrompt: payload.system_prompt } : {}),
      eventBus,
      workspaceDir,
      ...(orchestrator !== undefined ? { orchestrator } : {}),
      // Phase 18 L2-6 — forward the approval store so SoulPlus can wire
      // the yolo → permission-mode bridge (see soul-plus.ts constructor).
      ...(approvalStateStore !== undefined ? { approvalStateStore } : {}),
    });

    // Phase 18 / 裁决 3 — expose a write-through `runtime` slot on the
    // ManagedSession so the A.10 test pattern
    // `managed.runtime.kosong = kosong` mutates the harness-level
    // delegate and therefore the real adapter the orchestrator talks
    // to. Production ManagedSession has no `runtime` field; this is a
    // harness convenience only.
    const kosongRef = (runtime as unknown as { __slot?: { inner: KosongAdapter } }).__slot;
    if (kosongRef !== undefined) {
      (managed as unknown as { runtime: { kosong: KosongAdapter } }).runtime = {
        get kosong(): KosongAdapter {
          return kosongRef.inner;
        },
        set kosong(next: KosongAdapter) {
          kosongRef.inner = next;
        },
      };
    }

    const state = getOrInitSessionState(perSession, managed.sessionId);

    // Phase 18 A.10 — when initialize.hooks references a tool name
    // that isn't in the builtin registry (e.g. the test-only "Bash"
    // matcher), register a local no-op stub so Soul reaches the
    // `beforeToolCall` gate and fires PreToolUse. Without this the
    // orchestrator's findTool short-circuits before hooks run. The
    // stub runs entirely in-process — it does NOT emit a tool.call
    // reverse-RPC frame, so the hook.request test can assert the
    // reverse-RPC is exactly one `hook.request`.
    for (const entry of initialHooks) {
      if (typeof entry.matcher !== 'string') continue;
      const toolName = entry.matcher;
      const alreadyPresent = managed.soulPlus
        .getTools()
        .some((t) => t.name === toolName);
      if (alreadyPresent) continue;
      await managed.soulPlus.registerDynamicTool(makeLocalStubTool(toolName));
    }

    // Phase 18 A.1 / A.2 — pre-register external tools declared at
    // initialize-time. Each one becomes a Soul-visible Tool that
    // round-trips through `tool.call` reverse-RPC when the LLM calls
    // it.
    if (reverse !== undefined) {
      for (const ext of initialExternalTools) {
        state.externalTools.set(ext.name, {
          description: ext.description,
          input_schema: ext.input_schema,
        });
        await managed.soulPlus.registerDynamicTool(
          buildExternalToolProxy({
            name: ext.name,
            description: ext.description,
            inputSchema: ext.input_schema,
            sendToolCall: async (call, signal) => {
              const response = await reverse.sendRequest(
                'tool.call',
                managed.sessionId,
                { id: call.id, name: call.name, args: call.args },
                { timeoutMs: 3_000, signal },
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
      }
    }

    // Phase 18 A.14 — wire event bridge (status.update + turn.* + ...)
    // Tests that still install their own bridge via
    // `installWireEventBridge` disable this one via a disposer stashed
    // on the eventBus (see `test/e2e/helpers/wire-event-bridge.ts`).
    const eventBusHasExternal = (
      eventBus as unknown as { __hasExternalBridge?: boolean }
    ).__hasExternalBridge === true;
    if (server !== undefined && !eventBusHasExternal) {
      const dispose = installHarnessWireEventBridge({
        server,
        managed,
        eventBus,
        state,
      });
      state.bridgeDispose = dispose;
      (eventBus as unknown as { __autoBridgeDispose?: () => void })
        .__autoBridgeDispose = dispose;
    }

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
      const state = perSession.get(payload.session_id);
      state?.bridgeDispose?.();
      perSession.delete(payload.session_id);
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

  //
  // HARNESS-ONLY BEHAVIOR — session.prompt
  // --------------------------------------
  // This handler occasionally AWAITS turn completion before returning
  // the prompt response (see `shouldAwaitTurn` below). v2 §3.5 says
  // `session.prompt` is non-blocking: the canonical production handler
  // in the real `runWire` binary (Phase 11) MUST return
  // `{turn_id, status:"started"}` immediately and push any
  // -32001/-32002/-32003 error codes via `session.error` wire events
  // plus the eventual `turn.end` frame.
  //
  // The awaiting variant lives here only because the in-memory wire
  // harness' `collectUntilResponse(promptReq.id)` helper snapshots
  // events at response time; for the Phase 18 A.11-A.13 tests to
  // assert the business error code on the prompt's response frame the
  // handler has to hold the response until the turn settles. Do not
  // lift this pattern into production.
  //
  router.registerMethod('session.prompt', 'conversation', async (msg, transport, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const payload = (msg.data ?? {}) as SessionPromptRequestData;

    // Phase 17 A.4 — -32602 Invalid params. session.prompt.input must be
    // a string or a UserInputPart[] (text / image_url / video_url).
    // Anything else (number, boolean, null, bare object) is a schema
    // violation and must surface as JSON-RPC -32602 rather than crashing
    // the dispatch or silently stringifying.
    if (
      typeof payload.input !== 'string' &&
      !Array.isArray(payload.input)
    ) {
      return createWireResponse({
        requestId: msg.id,
        sessionId: msg.session_id,
        error: {
          code: -32602,
          message: 'Invalid params: input must be a string or UserInputPart[]',
        },
      });
    }

    let inputText: string;
    let inputParts: readonly UserInputPart[] | undefined;
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

    // Phase 18 A.11 — -32001 if no model was ever set (ContextState
    // reports empty string).
    if (!managed.contextState.model || managed.contextState.model === '') {
      return createWireResponse({
        requestId: msg.id,
        sessionId: msg.session_id,
        error: {
          code: -32001,
          message: 'No LLM configured for this session.',
        },
      });
    }

    // Phase 18 A.12 — capability mismatch check.
    const parts = inputParts ?? [];
    const hasImage = parts.some((p) => p.type === 'image_url');
    const hasVideo = parts.some((p) => p.type === 'video_url');
    // Resolve the REAL kosong (behind the harness delegator, if any)
    // so capability / scripted-error probes read from the actual
    // FakeKosongAdapter rather than the thin wrapper.
    const kosongUnwrapped =
      (runtime as unknown as { __slot?: { inner: unknown } }).__slot?.inner ??
      runtime.kosong;
    // FakeKosongAdapter exposes a legacy `capabilities` flag blob
    // (image_in/video_in/audio_in, each optional). Phase 19 Slice B's
    // production helper takes an explicit ModelCapability; build one
    // from the blob so pre-existing wire tests (Phase 18) stay green.
    //
    // Two-level permissive mapping (legacy 裁决 1, test-only):
    //   1. `capabilities` entirely absent → skip `checkLLMCapabilities`
    //      (= "no declared matrix" → no constraint).
    //   2. Individual flag absent (e.g. `image_in === undefined`) → treat
    //      as `true` via `flag !== false`. This matches the old
    //      phase18-extensions helper where only an explicit `false`
    //      rejected a modality.
    //
    // Production path in `turn-manager.ts` uses stricter semantics —
    // `capability === undefined` → skip gate, but when a capability is
    // returned every field is authoritative. This asymmetry is
    // deliberate: the harness layer exists to keep legacy tests
    // running without requiring them to all declare complete matrices.
    const capsBlob = (kosongUnwrapped as { capabilities?: {
      image_in?: boolean; video_in?: boolean; audio_in?: boolean;
    } }).capabilities;
    const capabilityMismatch = capsBlob === undefined
      ? undefined
      : checkLLMCapabilities({
          model: managed.contextState.model,
          inputContainsImage: hasImage,
          inputContainsVideo: hasVideo,
          inputContainsAudio: false,
          capability: {
            image_in: capsBlob.image_in !== false,
            video_in: capsBlob.video_in !== false,
            audio_in: capsBlob.audio_in !== false,
            thinking: false,
            tool_use: false,
            max_context_tokens: 0,
          },
        });
    if (capabilityMismatch !== undefined) {
      return createWireResponse({
        requestId: msg.id,
        sessionId: msg.session_id,
        error: {
          code: -32002,
          message: capabilityMismatch.message,
        },
      });
    }

    try {
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

      // Phase 18 A.14 — emit a status.update snapshot right after the
      // turn is armed so downstream consumers (wire bridge, TUI) see
      // the fresh context/token/model payload synchronously with the
      // `turn.begin` frame. TurnManager already emits another
      // status.update at `onTurnEnd`; this one covers the "turn
      // started" snapshot point callers need to read before the turn
      // completes.
      managed.soulPlus.getTurnManager().emitStatusUpdate({
        input: 0,
        output: 0,
      });

      // Phase 18 A.2 / A.13 / A.14 — block the dispatch response on
      // turn completion when the harness-installed wire bridge is in
      // use (auto-bridge active == Phase 18 caller). Blocking lets
      // the turn's reverse RPCs (`tool.call`) + the terminal
      // `turn.end` / `status.update` land inside the test's
      // `collectUntilResponse` window and surfaces the -32003 error
      // code. Tests that install their own bridge (pre-Phase-18
      // wire-prompt / wire-approvals-tools) opt out by setting the
      // `__hasExternalBridge` marker; the `started` ack returns
      // immediately so the concurrent-prompt pattern still works.
      const autoBridgeActive =
        (eventBus as unknown as { __hasExternalBridge?: boolean })
          .__hasExternalBridge !== true;
      const shouldAwaitTurn = autoBridgeActive;
      if (
        shouldAwaitTurn &&
        'turn_id' in (dispatch as DispatchResponse)
      ) {
        const turnId = (dispatch as { turn_id: string }).turn_id;
        const tm = managed.soulPlus.getTurnManager();
        // Race the turn-completion wait against a time budget. If the
        // turn settles inside the budget (synchronous error path used
        // by Phase 18 A.11-A.13 tests, or the external-tool reverse
        // RPC timeout at 3 s used by A.2), we can surface the -32003
        // code in the prompt response. If it is still running after
        // the budget — e.g. a test that deliberately hangs kosong to
        // exercise cancel/steer behaviour — we drop back to the
        // non-blocking `started` ack so the response never outlives
        // the turn itself. Budget is chosen so A.2 (3 s external RPC)
        // + A.11-A.13 (sync errors) complete inside it, while steer /
        // cancel-style hang tests don't starve the 5 s vitest default.
        const AWAIT_BUDGET_MS = 4_000;
        const completed = await Promise.race<'done' | 'timeout'>([
          tm.awaitTurn(turnId).then(() => 'done' as const),
          new Promise<'timeout'>((resolve) =>
            setTimeout(() => resolve('timeout'), AWAIT_BUDGET_MS),
          ),
        ]);
        if (completed === 'done') {
          const finalReason = tm.getTerminalReason(turnId);
          if (finalReason === 'error') {
            return createWireResponse({
              requestId: msg.id,
              sessionId: msg.session_id,
              error: {
                code: -32003,
                message: 'Provider error during turn',
              },
            });
          }
        }
      }

      return createWireResponse({
        requestId: msg.id,
        sessionId: msg.session_id,
        data: dispatch as unknown as DispatchResponse,
      });
    } catch (error) {
      const classified = classifyBusinessError(error);
      if (classified !== undefined) {
        return createWireResponse({
          requestId: msg.id,
          sessionId: msg.session_id,
          error: classified,
        });
      }
      throw error;
    }
  });

  router.registerMethod('session.steer', 'conversation', async (msg, _transport, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const payload = (msg.data ?? {}) as SessionSteerRequestData;
    await managed.soulPlus.dispatch({
      method: 'session.steer',
      data: { input: { text: payload.input } },
    });
    // Phase 17 E.2 — SessionSteerResponseData is {ok: true}. The
    // original DispatchResponse shape carried {queued: true}; E.2
    // aligned the wire contract with the dispatch shape, then settled
    // on {ok: true} as the stable public surface.
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
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

  // Phase 17 A.5 — session.resume reports turn_count + last_turn_id
  // derived from the session's wire.jsonl (read on-disk to survive
  // process restarts in E2E; tests flush via journalWriter.flush).
  // Also emits an initial status.update snapshot (model + plan_mode)
  // so the client refreshes indicators on reconnect.
  if (pathConfig !== undefined) {
    router.registerMethod('session.resume', 'conversation', async (msg, _transport, session) => {
      const managed = session as ReturnType<SessionManager['get']>;
      if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);

      const wirePath = pathConfig.wirePath(msg.session_id);
      let turnCount = 0;
      let lastTurnId: string | undefined;
      try {
        const { readFile } = await import('node:fs/promises');
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

      eventBus.emit({
        type: 'status.update',
        data: {
          model: managed.contextState.model || defaultModel,
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

    // Phase 17 A.5 — session.replay streams wire.jsonl body as chunked
    // `session.replay.chunk` wire events, then a terminating
    // `session.replay.end`. `from_seq` lets clients resume partway.
    router.registerMethod('session.replay', 'management', async (msg, transport, session) => {
      const managed = session as ReturnType<SessionManager['get']>;
      if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
      void managed;

      const payload = (msg.data ?? {}) as { from_seq?: number };
      const fromSeq = typeof payload.from_seq === 'number' ? payload.from_seq : 0;

      const wirePath = pathConfig.wirePath(msg.session_id);
      let body: unknown[] = [];
      try {
        const { readFile } = await import('node:fs/promises');
        const content = await readFile(wirePath, 'utf8');
        const lines = content.split('\n').filter((l) => l.length > 0);
        body = lines.slice(1).flatMap((line) => {
          try {
            return [JSON.parse(line) as unknown];
          } catch {
            return [];
          }
        });
      } catch {
        /* missing wire.jsonl → empty replay */
      }

      const filtered = body.filter((r: unknown) => {
        const seq = (r as { seq?: number }).seq;
        return seq === undefined || seq >= fromSeq;
      });

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
        await transport.send(JSON.stringify(chunkFrame));
      }

      const endFrame = createWireEvent({
        method: 'session.replay.end',
        sessionId: msg.session_id,
        seq: replaySeq,
        requestId: msg.id,
        data: { total: filtered.length },
      });
      await transport.send(JSON.stringify(endFrame));

      return createWireResponse({
        requestId: msg.id,
        sessionId: msg.session_id,
        data: { ok: true, total: filtered.length },
      });
    });
  }

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

  // ── Phase 18 A.9 — session.subscribe / unsubscribe ───────────────

  router.registerMethod('session.subscribe', 'management', async (msg) => {
    const payload = (msg.data ?? {}) as { events?: string[] };
    const state = getOrInitSessionState(perSession, msg.session_id);
    if (payload.events !== undefined && Array.isArray(payload.events)) {
      state.eventFilter = new Set(payload.events);
    } else {
      state.eventFilter = undefined;
    }
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  router.registerMethod('session.unsubscribe', 'management', async (msg) => {
    const state = getOrInitSessionState(perSession, msg.session_id);
    state.eventFilter = undefined;
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  router.registerMethod('session.compact', 'management', async (msg) => {
    // Phase 9 stub — real compaction takes a provider + journal
    // capability which the harness doesn't wire.
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  // ── Slice 20-A — session.clear ───────────────────────────────────
  router.registerMethod('session.clear', 'management', async (msg, _transport, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    await managed.sessionControl.clear();
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  // ── Phase 18 A.3 — session.setModel ──────────────────────────────

  router.registerMethod('session.setModel', 'config', async (msg, _transport, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const payload = (msg.data ?? {}) as Partial<SessionSetModelRequestData>;
    if (typeof payload.model !== 'string') {
      throw new Error('invalid params: model must be a string');
    }
    await managed.soulPlus.setModel(payload.model);
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  // ── Phase 18 A.4 — session.setPlanMode ────────────────────────────

  router.registerMethod('session.setPlanMode', 'config', async (msg, _transport, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const payload = (msg.data ?? {}) as Partial<SessionSetPlanModeRequestData>;
    const enabled = Boolean(payload.enabled);
    await managed.sessionControl.setPlanMode(enabled);
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  // ── Phase 18 A.5 — session.setYolo ────────────────────────────────

  router.registerMethod('session.setYolo', 'config', async (msg, _transport, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const payload = (msg.data ?? {}) as Partial<SessionSetYoloRequestData>;
    const enabled = Boolean(payload.enabled);
    if (approvalStateStore !== undefined) {
      await approvalStateStore.setYolo(enabled);
    } else {
      await managed.sessionControl.setYolo(enabled);
    }
    // Emit a status.update so downstream observers pick up the yolo
    // change (裁决 2 — Coordinator added this follow-up assertion).
    managed.soulPlus.getTurnManager().emitStatusUpdate({ input: 0, output: 0 });
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  // ── Phase 18 A.6 — session.setThinking ────────────────────────────

  router.registerMethod('session.setThinking', 'config', async (msg, _transport, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const payload = (msg.data ?? {}) as Partial<SessionSetThinkingRequestData>;
    if (typeof payload.level !== 'string') {
      throw new Error('invalid params: level must be a string');
    }
    await managed.soulPlus.setThinking(payload.level);
    // Phase 18 A.6 — emit a dedicated thinking.changed event so clients
    // can observe the change on the wire.
    if (server !== undefined) {
      const { WireCodec } = await import('../../../src/wire-protocol/codec.js');
      const codec = new WireCodec();
      const frame = createWireEvent({
        method: 'thinking.changed',
        sessionId: msg.session_id,
        seq: 0,
        agentType: 'main',
        data: { level: payload.level },
      });
      void server.send(codec.encode(frame)).catch(() => {});
    }
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  // ── Phase 18 A.7 — session.addSystemReminder ──────────────────────

  router.registerMethod('session.addSystemReminder', 'config', async (msg, _transport, session) => {
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

  // ── Phase 18 A.8 — dynamic tool management ────────────────────────

  router.registerMethod('session.registerTool', 'tools', async (msg, _transport, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const payload = (msg.data ?? {}) as Partial<SessionRegisterToolRequestData>;
    if (typeof payload.name !== 'string' || payload.name.length === 0) {
      throw new Error('invalid params: name must be a non-empty string');
    }
    const state = getOrInitSessionState(perSession, msg.session_id);
    state.externalTools.set(payload.name, {
      description: payload.description ?? '',
      input_schema: payload.input_schema,
    });
    if (reverse !== undefined) {
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
              { timeoutMs: 3_000, signal },
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
    }
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { ok: true },
    });
  });

  router.registerMethod('session.removeTool', 'tools', async (msg, _transport, session) => {
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

  router.registerMethod('session.listTools', 'tools', async (msg, _transport, session) => {
    const managed = session as ReturnType<SessionManager['get']>;
    if (managed === undefined) throw new Error(`Session not found: ${msg.session_id}`);
    const state = getOrInitSessionState(perSession, msg.session_id);
    const allTools = managed.soulPlus.getTools();
    const activeSet = state.activeToolNames === undefined
      ? undefined
      : new Set(state.activeToolNames);
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

  router.registerMethod('session.setActiveTools', 'tools', async (msg, _transport, session) => {
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

  // ── Phase 18 §E.3 — session.getBackgroundTasks ──────────────────

  router.registerMethod('session.getBackgroundTasks', 'management', async (msg) => {
    // Background tasks (bash / agent) live in the per-session
    // BackgroundProcessManager which the in-memory harness does not
    // wire. Persisted subagent records are pulled directly from
    // `SubagentStore` so a host can observe child progress across
    // process restarts. Field name `agent_instances` keeps the slice
    // 18-3 deviation note in migration-report.md (Coordinator-approved
    // reuse of `SubagentStore` instead of `AgentInstanceStore`).
    let agentInstances: unknown[] = [];
    if (pathConfig !== undefined) {
      // `SubagentStore.listInstances()` already tolerates a missing
      // `subagents/` directory (returns `[]`) — no outer try/catch
      // needed. Anything it re-throws is a genuine disk-level fault
      // that deserves to surface as a wire error rather than be
      // silently swallowed.
      const store = new SubagentStore(pathConfig.sessionDir(msg.session_id));
      agentInstances = await store.listInstances();
    }
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: {
        background_tasks: [],
        agent_instances: agentInstances,
      },
    });
  });

  // ── Phase 18 §E.4 — session.stopBackgroundTask ──────────────────

  router.registerMethod('session.stopBackgroundTask', 'management', async (msg) => {
    const payload = (msg.data ?? {}) as { task_id?: string };
    const taskId = payload.task_id;
    // Harness has no BPM wired — every task id is unknown. Still must
    // return a handler-level error rather than method-not-found so the
    // wire layer surfaces a structured response.
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      error: {
        code: -32000,
        message: `Background task not found: ${taskId ?? '(missing task_id)'}`,
      },
    });
  });

  // ── Phase 18 §E.5 — session.getBackgroundTaskOutput ─────────────

  router.registerMethod('session.getBackgroundTaskOutput', 'management', async (msg) => {
    // Harness has no BPM — return empty output so the method is
    // observably wired without the test needing to seed a real task.
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { output: '' },
    });
  });

  // ── Phase 18 §F.1 — session.rollback ─────────────────────────────

  router.registerMethod('session.rollback', 'management', async (msg) => {
    const payload = (msg.data ?? {}) as { n_turns_back?: number };
    const n = typeof payload.n_turns_back === 'number' ? payload.n_turns_back : 0;
    if (n < 0) {
      return createWireResponse({
        requestId: msg.id,
        sessionId: msg.session_id,
        error: {
          code: -32602,
          message: `session.rollback: n_turns_back must be >= 0 (got ${n})`,
        },
      });
    }
    const result = await sessionManager.rollbackSession(msg.session_id, n);
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { new_turn_count: result.new_turn_count },
    });
  });

  // ── Phase 18 §F.2 — session.listSkills ───────────────────────────

  router.registerMethod('session.listSkills', 'management', async (msg) => {
    // SkillManager isn't injected into the harness; return an empty
    // invocable subset so the wire surface is exercised. Real-skill
    // filtering lives in the SoulPlus unit tests.
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      data: { skills: [] },
    });
  });

  // ── Phase 18 §F.3 — session.activateSkill ────────────────────────

  router.registerMethod('session.activateSkill', 'management', async (msg) => {
    const payload = (msg.data ?? {}) as { name?: string };
    const name = payload.name ?? '(missing)';
    return createWireResponse({
      requestId: msg.id,
      sessionId: msg.session_id,
      error: {
        code: -32000,
        message: `Skill not found: ${name}`,
      },
    });
  });

  void createWireEvent; // retained for future event-producing handlers
}
