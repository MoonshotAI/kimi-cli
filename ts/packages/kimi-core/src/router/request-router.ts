/**
 * RequestRouter — five-channel dispatch (§6.1).
 *
 * Routes incoming WireMessages to the appropriate handler based on:
 *   1. Response messages → pending request resolver
 *   2. Process-level messages (session_id = "__process__") → processHandlers
 *   3. Session-level messages → session lookup + method handler
 *
 * Channels:
 *   - conversation: session.prompt / session.steer / session.cancel / session.resume
 *   - management:   session.getStatus / session.getHistory / session.fork / ...
 *   - config:       session.setModel / session.setSystemPrompt / session.setPlanMode / ...
 *   - tools:        session.registerTool / session.removeTool / session.listTools / ...
 *   - process:      initialize / shutdown / session.create / session.list / ...
 */

import type { Transport } from '../transport/types.js';
import { PROCESS_SESSION_ID } from '../wire-protocol/types.js';
import type { ChannelType, WireMessage } from '../wire-protocol/types.js';
import {
  WireMethodNotFoundError,
  WireSessionNotFoundError,
} from '../wire-protocol/errors.js';

export type RouteHandler = (
  msg: WireMessage,
  transport: Transport,
  session?: unknown,
) => Promise<WireMessage | void>;

export interface RequestRouterDeps {
  readonly sessionManager: SessionManagerLike;
}

/** Minimal interface the router needs from SessionManager. */
export interface SessionManagerLike {
  get(sessionId: string): unknown;
}

export interface RouteRegistration {
  channel: ChannelType;
  handler: RouteHandler;
}

/**
 * Internal bookkeeping for a reverse-RPC in-flight request. Keeping both
 * `resolve` and `reject` lets us actively reject when the transport closes
 * or the caller times out — before Phase 21 §A the router only stored the
 * resolver, so cancelled requests leaked and timeouts could not tear down
 * the map entry.
 */
interface PendingEntry {
  readonly resolve: (msg: WireMessage) => void;
  readonly reject: (reason: unknown) => void;
}

export class RequestRouter {
  private readonly handlers = new Map<string, RouteRegistration>();
  private readonly processHandlers = new Map<string, RouteHandler>();
  private readonly pendingRequests = new Map<string, PendingEntry>();

  constructor(private readonly deps: RequestRouterDeps) {}

  registerMethod(method: string, channel: ChannelType, handler: RouteHandler): void {
    this.handlers.set(method, { channel, handler });
  }

  registerProcessMethod(method: string, handler: RouteHandler): void {
    this.processHandlers.set(method, handler);
  }

  async dispatch(msg: WireMessage, transport: Transport): Promise<WireMessage | void> {
    // 1. Response messages → resolve pending request
    if (msg.type === 'response') {
      const requestId = msg.request_id;
      if (requestId) {
        const entry = this.pendingRequests.get(requestId);
        if (entry) {
          this.pendingRequests.delete(requestId);
          entry.resolve(msg);
          return;
        }
      }
      return;
    }

    const method = msg.method;

    // 2. Process-level messages
    if (msg.session_id === PROCESS_SESSION_ID) {
      const handler = method ? this.processHandlers.get(method) : undefined;
      if (!handler) {
        throw new WireMethodNotFoundError(method ?? '(none)');
      }
      return handler(msg, transport);
    }

    // 3. Session-level messages — verify session exists
    const session = this.deps.sessionManager.get(msg.session_id);
    if (!session) {
      throw new WireSessionNotFoundError(msg.session_id);
    }

    const registration = method ? this.handlers.get(method) : undefined;
    if (!registration) {
      throw new WireMethodNotFoundError(method ?? '(none)');
    }

    return registration.handler(msg, transport, session);
  }

  /**
   * Register a pending reverse-RPC request. Both callbacks are optional at
   * the call site for back-compat: callers that don't pass a `reject` still
   * work (their promise simply stays pending if the transport dies), but
   * new call sites should wire both so `cancelPendingRequest` /
   * `rejectAllPending` can actively tear them down.
   */
  registerPendingRequest(
    requestId: string,
    resolve: (msg: WireMessage) => void,
    reject?: (reason: unknown) => void,
  ): void {
    this.pendingRequests.set(requestId, {
      resolve,
      reject: reject ?? ((): void => { /* legacy caller — no-op */ }),
    });
  }

  /**
   * Cancel a single pending reverse-RPC request. Phase 21 §A — reverse-rpc
   * client cleanup calls this on timeout, abort, or transport send error
   * so the map doesn't leak stale entries. Returns `true` if an entry was
   * present (and therefore rejected); `false` if the request had already
   * settled or never existed.
   */
  cancelPendingRequest(requestId: string, reason?: unknown): boolean {
    const entry = this.pendingRequests.get(requestId);
    if (entry === undefined) return false;
    this.pendingRequests.delete(requestId);
    entry.reject(reason ?? new Error(`reverse RPC ${requestId} cancelled`));
    return true;
  }

  /**
   * Reject every pending reverse-RPC request — call on transport close.
   * Phase 21 §A fix: previously this silently removed entries without
   * settling their promises, so callers (WireHookExecutor, ApprovalRuntime
   * reverse-RPC, buildExternalToolProxy) would hang until their own
   * timeout fired. Now each entry's `reject` fires synchronously so
   * upstream code observes a concrete failure.
   */
  rejectAllPending(reason?: string): void {
    const err = new Error(reason ?? 'router: all pending reverse-RPC requests cancelled');
    const snapshot = [...this.pendingRequests.entries()];
    this.pendingRequests.clear();
    for (const [, entry] of snapshot) {
      entry.reject(err);
    }
  }
}
