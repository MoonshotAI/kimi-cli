/**
 * Wire E2E harness — Phase 9 §4.
 *
 * Two flavours share one `WireE2EHarness` interface:
 *   - `createWireE2EHarness()` wires a pair of `MemoryTransport`s to an
 *     in-process RequestRouter + SessionManager, so tests can drive the
 *     full Wire protocol without spawning a subprocess.
 *   - `startWireSubprocess()` (in `./wire-subprocess-harness.ts`) boots
 *     the `kimi --wire` binary over stdio. Currently stubbed pending
 *     Phase 11 (see README "Known Gaps").
 *
 * The harness exposes `send` / `request` / `expectEvent` /
 * `collectUntilResponse` / `collectUntilRequest` / `dispose` — a
 * direct transliteration of `tests_e2e/wire_helpers.py`.
 *
 * The max-dependencies warning is silenced on this file because the
 * harness pulls together hooks / router / session / soul-plus /
 * transport / wire-protocol — by design a one-stop test entrypoint.
 * Every module has already been funneled through its own barrel
 * (session/index, soul-plus/index, wire-protocol/index, kosong/index,
 * runtime/internal-deps). Further splitting would just re-introduce
 * `helpers/wire/wire-e2e-harness-deps.ts` boilerplate without winning
 * readability.
 */
/* oxlint-disable import/max-dependencies */

import { HookEngine } from '../../../src/hooks/engine.js';
import {
  RequestRouter,
  type RequestRouterDeps,
} from '../../../src/router/request-router.js';
import {
  PathConfig,
  SessionManager,
} from '../../../src/session/index.js';
import {
  InMemoryApprovalStateStore,
  SessionEventBus,
  ToolCallOrchestrator,
  type ApprovalRuntime,
} from '../../../src/soul-plus/index.js';
import type { KosongAdapter, Tool } from '../../../src/soul/index.js';
import {
  createLinkedTransportPair,
  type MemoryTransport,
} from '../../../src/transport/memory-transport.js';
import {
  createWireRequest,
  createWireResponse,
  InvalidWireEnvelopeError,
  MalformedWireFrameError,
  WireCodec,
  type WireMessage,
} from '../../../src/wire-protocol/index.js';
import { mapToWireError } from '../../../src/wire-protocol/error-mapping.js';
import { ZodError } from 'zod';
import { CollectingEventSink } from '../../soul/fixtures/collecting-event-sink.js';
import {
  createTempEnv,
  type TempEnvHandle,
} from '../filesystem/temp-work-dir.js';
import {
  FakeKosongAdapter,
  resolveKosongPair,
  type FakeKosongAdapterOptions,
} from '../kosong/index.js';
import { createTestApproval } from '../runtime/internal-deps.js';
import { registerDefaultWireHandlers } from './default-handlers.js';

// ── Shared interface ──────────────────────────────────────────────────

export interface WireCollectUntilResponseOptions {
  readonly timeoutMs?: number;
  readonly requestHandler?: (req: WireMessage) => WireMessage | Promise<WireMessage>;
}

export interface WireCollectUntilRequestOptions {
  readonly timeoutMs?: number;
}

export interface WireE2EHarness {
  readonly received: readonly WireMessage[];
  send(msg: WireMessage): Promise<void>;
  request(
    method: string,
    params: unknown,
    opts?: { sessionId?: string; timeoutMs?: number },
  ): Promise<WireMessage>;
  expectEvent(
    method: string,
    opts?: { timeoutMs?: number; matcher?: (msg: WireMessage) => boolean },
  ): Promise<WireMessage>;
  collectUntilResponse(
    requestId: string,
    opts?: WireCollectUntilResponseOptions,
  ): Promise<{ response: WireMessage; events: readonly WireMessage[] }>;
  collectUntilRequest(
    opts?: WireCollectUntilRequestOptions,
  ): Promise<{ request: WireMessage; events: readonly WireMessage[] }>;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

// ── Frame queue ─────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Monotonic frame buffer with pluggable predicates. Every pushed frame
 * evaluates every registered waiter once; matching waiters resolve.
 */
export class WireFrameQueue {
  private readonly received: WireMessage[] = [];
  private readonly listeners: Array<(msg: WireMessage) => void> = [];
  private disposed = false;

  get snapshot(): readonly WireMessage[] {
    return this.received;
  }

  push(msg: WireMessage): void {
    this.received.push(msg);
    // Clone the listener list before iterating: a listener that
    // resolves via `waitFor` unsubscribes itself synchronously, which
    // would mutate the array mid-iteration and skip a neighbour.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const l of [...this.listeners]) l(msg);
  }

  subscribe(listener: (msg: WireMessage) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  async waitFor(
    predicate: (msg: WireMessage) => boolean,
    timeoutMs: number,
    label?: string,
  ): Promise<WireMessage> {
    // Fast-path — scan backlog first.
    for (const m of this.received) {
      if (predicate(m)) return m;
    }
    return new Promise<WireMessage>((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('WireFrameQueue disposed'));
        return;
      }
      const timer = setTimeout(() => {
        unsubscribe();
        const desc = label ?? 'wire frame';
        reject(new Error(`${desc} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const unsubscribe = this.subscribe((m) => {
        if (predicate(m)) {
          clearTimeout(timer);
          unsubscribe();
          resolve(m);
        }
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.length = 0;
  }
}

// ── In-memory harness ──────────────────────────────────────────────────

// ── Dispatch-error → wire-error translation ───────────────────────────

/**
 * Map a thrown `RequestRouter.dispatch` error onto a JSON-RPC style
 * wire error response (Review Round 2 R2-1). Code choices mirror v2
 * §3.1 / the Python wire bridge:
 *   -32600  malformed envelope the router accepted but rejected
 *   -32601  method not registered
 *   -32602  invalid params (reserved — router doesn't throw this today
 *           but we surface it if a handler raises with the token)
 *   -32000  session-level errors ("Session not found" etc.)
 *   -32603  fallback for unclassified errors
 */
function buildErrorResponseFromDispatchError(
  request: WireMessage,
  err: unknown,
): WireMessage {
  const message = err instanceof Error ? err.message : String(err);
  // Phase 17 §A.4 — delegate to `mapToWireError` first. Codes
  // specific to the router dispatch layer (method-not-found, session-
  // not-found) still need the regex fallback since they are thrown as
  // plain `Error` instances from RequestRouter.
  let code: number;
  if (err instanceof InvalidWireEnvelopeError) {
    code = -32600;
  } else if (err instanceof MalformedWireFrameError) {
    code = -32700;
  } else if (err instanceof ZodError) {
    code = -32602;
  } else if (/method not found/i.test(message)) {
    code = -32601;
  } else if (/invalid params/i.test(message)) {
    code = -32602;
  } else if (/session not found/i.test(message)) {
    code = -32000;
  } else {
    code = -32603;
  }
  // Phase 17 §A.4 — ZodError messages are the raw issues JSON which
  // clients can't parse. Override with a short human-friendly string
  // and stash the issues on `details` for diagnostics.
  const friendlyMessage = err instanceof ZodError ? 'Invalid params' : message;
  const wireError: { code: number; message: string; details?: unknown } = {
    code,
    message: friendlyMessage,
  };
  if (err instanceof ZodError) {
    wireError.details = { issues: err.issues };
  }
  return createWireResponse({
    requestId: request.id,
    sessionId: request.session_id,
    error: wireError,
  });
}

export interface WireE2EInMemoryHarness extends WireE2EHarness {
  readonly client: MemoryTransport;
  readonly server: MemoryTransport;
  readonly router: RequestRouter;
  readonly sessionManager: SessionManager;
  readonly kosong: FakeKosongAdapter;
  readonly approval: ApprovalRuntime;
  readonly eventBus: SessionEventBus;
  readonly events: CollectingEventSink;
  readonly tools: readonly Tool[];
  readonly workDir: string;
  readonly shareDir: string;
  readonly homeDir: string;
  readonly queue: WireFrameQueue;
}

export interface CreateWireE2EHarnessOptions {
  readonly tools?: readonly Tool[];
  readonly kosong?: KosongAdapter | FakeKosongAdapter;
  readonly kosongOptions?: FakeKosongAdapterOptions;
  readonly approval?: ApprovalRuntime;
  readonly workDir?: string;
  readonly shareDir?: string;
  readonly homeDir?: string;
  readonly routerOverrides?: (router: RequestRouter) => void | Promise<void>;
  readonly routerDeps?: Partial<RequestRouterDeps>;
  readonly model?: string;
  readonly initialSessionId?: string;
}

export async function createWireE2EHarness(
  opts?: CreateWireE2EHarnessOptions,
): Promise<WireE2EInMemoryHarness> {
  const needsTemp =
    opts?.workDir === undefined || opts?.shareDir === undefined || opts?.homeDir === undefined;
  let tempHandle: TempEnvHandle | undefined;
  if (needsTemp) {
    tempHandle = await createTempEnv();
  }
  const workDir = opts?.workDir ?? tempHandle!.workDir.path;
  const shareDir = opts?.shareDir ?? tempHandle!.shareDir.path;
  const homeDir = opts?.homeDir ?? tempHandle!.homeDir.path;

  const suppliedKosong =
    opts?.kosong ?? (opts?.kosongOptions !== undefined ? new FakeKosongAdapter(opts.kosongOptions) : undefined);
  const { kosong: rawKosong, fake } = resolveKosongPair(suppliedKosong);
  // Phase 18 / 裁决 3 — wrap the raw adapter in a mutable delegate so
  // tests can hot-swap the provider after session boot without having
  // to go through `SessionManager.createSession`. The delegate
  // satisfies the `KosongAdapter` shape by forwarding every `chat`
  // call to the current `inner` reference; the slot is also exposed on
  // each ManagedSession as `managed.runtime.kosong` (write-through
  // proxy) so the legacy `managed.runtime.kosong = newAdapter`
  // hot-swap pattern keeps working.
  const kosongSlot: { inner: KosongAdapter } = { inner: rawKosong };
  const kosong: KosongAdapter = {
    async chat(params) {
      return kosongSlot.inner.chat(params);
    },
  };
  void fake;
  const approval = opts?.approval ?? createTestApproval({ yolo: true });

  const pathConfig = new PathConfig({ home: homeDir });
  const sessionManager = new SessionManager(pathConfig);
  // Phase 18 L2-6 — shared InMemoryApprovalStateStore so the wire
  // `session.setYolo` handler and SoulPlus's `onChanged` listener see
  // the same store. Production hosts that wire their own store should
  // pass it through; here we just need a single instance that threads
  // through `session.create` AND the handler closure.
  const approvalStateStore = new InMemoryApprovalStateStore();

  const eventBus = new SessionEventBus();
  const events = new CollectingEventSink();
  const eventListener = (
    event: Parameters<Parameters<SessionEventBus['on']>[0]>[0],
  ): void => {
    events.emit(event);
  };
  eventBus.on(eventListener);

  const tools: readonly Tool[] = opts?.tools ?? [];

  // Orchestrator so the supplied `approval` actually vetoes tool calls.
  const hookEngine = new HookEngine({ executors: new Map() });
  const orchestrator = new ToolCallOrchestrator({
    hookEngine,
    // initialize does not create a session; individual session.create
    // calls will mint session ids. Orchestrator's sessionId closure is
    // only read during hook dispatch, which happens inside a session.
    sessionId: () => 'ses_wire_harness',
    agentId: 'agent_main',
    approvalRuntime: approval,
    pathConfig,
  });

  const router = new RequestRouter({
    sessionManager,
    ...opts?.routerDeps,
  });

  const [client, server] = createLinkedTransportPair();
  const codec = new WireCodec();
  const queue = new WireFrameQueue();

  const runtimeValue = { kosong, __slot: kosongSlot } as unknown as {
    kosong: KosongAdapter;
  };
  registerDefaultWireHandlers({
    sessionManager,
    router,
    runtime: runtimeValue,
    kosong,
    tools,
    approval,
    orchestrator,
    eventBus,
    workspaceDir: workDir,
    defaultModel: opts?.model ?? 'test-model',
    server,
    hookEngine,
    approvalStateStore,
    pathConfig,
  });

  // Allow tests to install custom handlers that override defaults.
  if (opts?.routerOverrides !== undefined) {
    await opts.routerOverrides(router);
  }

  client.onMessage = (frame: string): void => {
    try {
      const msg = codec.decode(frame);
      queue.push(msg);
    } catch {
      /* swallow malformed frames */
    }
  };
  server.onMessage = (frame: string): void => {
    void (async (): Promise<void> => {
      // Phase 17 §A.4 — codec / envelope failures are now mapped to
      // -32700 / -32600 via `mapToWireError` and surfaced as responses
      // (request_id is null because we can't recover the client id).
      let msg: WireMessage;
      try {
        msg = codec.decode(frame);
      } catch (decodeError) {
        const mapping = mapToWireError(decodeError);
        try {
          const errResp = createWireResponse({
            requestId: undefined,
            sessionId: '__unknown__',
            error: mapping.error,
          });
          await server.send(codec.encode(errResp));
        } catch {
          /* transport may have closed — ignore */
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
        const errorResponse = buildErrorResponseFromDispatchError(msg, error);
        try {
          await server.send(codec.encode(errorResponse));
        } catch {
          /* transport may have closed mid-flight — ignore */
        }
      }
    })();
  };

  await Promise.all([client.connect(), server.connect()]);

  // Phase 17 §A.3 — if the approval helper exposes a deferred
  // `setReverseRpcSender` seam, wire it to the server now that the
  // transport is live. The runtime fires `approval.request` wire
  // frames via this closure; the client's response lands on a
  // pending-request resolver that routes the decision back into
  // `resolveRemote`.
  {
    const { isTestWiredApproval } = await import(
      '../runtime/create-test-approval.js'
    );
    if (isTestWiredApproval(approval)) {
      const wiredApproval = approval;
      wiredApproval.setReverseRpcSender((frame) => {
        const wireRequest = createWireRequest({
          method: frame.method,
          sessionId: frame.data.request_id,
          data: frame.data,
          from: 'core',
          to: 'client',
        });
        router.registerPendingRequest(wireRequest.id, (responseMsg) => {
          const decision = (responseMsg.data ?? {}) as {
            response?: 'approved' | 'rejected' | 'cancelled';
            feedback?: string;
            scope?: 'session';
          };
          if (decision.response === undefined) return;
          wiredApproval.resolveRemote({
            request_id: frame.data.request_id,
            response: decision.response,
            ...(decision.feedback !== undefined ? { feedback: decision.feedback } : {}),
            ...(decision.scope === 'session' ? { scope: 'session' as const } : {}),
          });
        });
        void server.send(codec.encode(wireRequest)).catch(() => {
          /* transport may have closed — ignore */
        });
      });
    }
  }

  async function send(msg: WireMessage): Promise<void> {
    await client.send(codec.encode(msg));
  }

  async function doRequest(
    method: string,
    params: unknown,
    o?: { sessionId?: string; timeoutMs?: number },
  ): Promise<WireMessage> {
    // Process-level methods (`initialize`, `session.create`, etc.) go
     // to `__process__`; session-scoped methods must pass `sessionId`.
     const sessionId = o?.sessionId ?? '__process__';
    const req = createWireRequest({ method, sessionId, data: params });
    const waitMs = o?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const waitPromise = queue.waitFor(
      (m) => m.type === 'response' && m.request_id === req.id,
      waitMs,
      `request '${method}' (id=${req.id})`,
    );
    await send(req);
    return waitPromise;
  }

  async function expectEvent(
    method: string,
    o?: { timeoutMs?: number; matcher?: (msg: WireMessage) => boolean },
  ): Promise<WireMessage> {
    const waitMs = o?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return queue.waitFor(
      (m) => {
        if (m.type !== 'event') return false;
        if (m.method !== method) return false;
        if (o?.matcher !== undefined && !o.matcher(m)) return false;
        return true;
      },
      waitMs,
      `event '${method}'`,
    );
  }

  async function collectUntilResponse(
    requestId: string,
    o?: WireCollectUntilResponseOptions,
  ): Promise<{ response: WireMessage; events: readonly WireMessage[] }> {
    const waitMs = o?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startAt = queue.snapshot.length;
    const processed = new Set<string>();
    let unsubscribe: (() => void) | undefined;

    // Install a passive listener that auto-replies to reverse-RPC
    // requests as they arrive. The wait-for loop still just watches for
    // the response frame.
    if (o?.requestHandler !== undefined) {
      const handler = o.requestHandler;
      unsubscribe = queue.subscribe((m) => {
        if (m.type !== 'request') return;
        if (processed.has(m.id)) return;
        processed.add(m.id);
        void (async (): Promise<void> => {
          try {
            const reply = await handler(m);
            await send(reply);
          } catch {
            /* tests will surface the underlying error via timeout */
          }
        })();
      });
      // Flush any requests already in the backlog.
      for (const m of queue.snapshot.slice(startAt)) {
        if (m.type === 'request' && !processed.has(m.id)) {
          processed.add(m.id);
          void (async (): Promise<void> => {
            try {
              const reply = await handler(m);
              await send(reply);
            } catch {
              /* swallow */
            }
          })();
        }
      }
    }

    try {
      const response = await queue.waitFor(
        (m) => m.type === 'response' && m.request_id === requestId,
        waitMs,
        `collectUntilResponse(request_id=${requestId})`,
      );
      // Python parity — `events` excludes the terminating response (it
      // is returned separately). Only `event` and reverse-RPC `request`
      // frames that arrived in the interval are interesting.
      const events = queue.snapshot
        .slice(startAt)
        .filter((m) => m.type === 'event' || m.type === 'request');
      return { response, events };
    } finally {
      unsubscribe?.();
    }
  }

  async function collectUntilRequest(
    o?: WireCollectUntilRequestOptions,
  ): Promise<{ request: WireMessage; events: readonly WireMessage[] }> {
    const waitMs = o?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startAt = queue.snapshot.length;
    const request = await queue.waitFor(
      (m) => m.type === 'request' && queue.snapshot.indexOf(m) >= startAt,
      waitMs,
      'collectUntilRequest',
    );
    const events = queue.snapshot
      .slice(startAt)
      .filter((m) => m.type === 'event');
    return { request, events };
  }

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    queue.dispose();
    // Review Round 2 R2-3 — dispose order:
    //   1. close sessions first so any in-flight wire events can still
    //      reach the bus / transport (transport-first would cause the
    //      closing session's final emits to hit a closed transport).
    //   2. detach event listener + close the transport pair
    //   3. clean temp dirs
    const live = await sessionManager.listSessions();
    for (const info of live) {
      try {
        await sessionManager.closeSession(info.session_id);
      } catch {
        /* ignore — best-effort cleanup */
      }
    }
    eventBus.off(eventListener);
    await client.close();
    if (tempHandle !== undefined) {
      await tempHandle.cleanup();
    }
  };

  return {
    get received(): readonly WireMessage[] {
      return queue.snapshot;
    },
    send,
    request: doRequest,
    expectEvent,
    collectUntilResponse,
    collectUntilRequest,
    dispose,
    [Symbol.asyncDispose]: dispose,
    client,
    server,
    router,
    sessionManager,
    kosong: fake,
    approval,
    eventBus,
    events,
    tools,
    workDir,
    shareDir,
    homeDir,
    queue,
  };
}
