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

export class RequestRouter {
  private readonly handlers = new Map<string, RouteRegistration>();
  private readonly processHandlers = new Map<string, RouteHandler>();
  private readonly pendingRequests = new Map<string, (msg: WireMessage) => void>();

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
        const resolver = this.pendingRequests.get(requestId);
        if (resolver) {
          this.pendingRequests.delete(requestId);
          resolver(msg);
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
        throw new Error(`Method not found: ${method ?? '(none)'}`);
      }
      return handler(msg, transport);
    }

    // 3. Session-level messages — verify session exists
    const session = this.deps.sessionManager.get(msg.session_id);
    if (!session) {
      throw new Error(`Session not found: ${msg.session_id}`);
    }

    const registration = method ? this.handlers.get(method) : undefined;
    if (!registration) {
      throw new Error(`Method not found: ${method ?? '(none)'}`);
    }

    return registration.handler(msg, transport, session);
  }

  registerPendingRequest(requestId: string, resolver: (msg: WireMessage) => void): void {
    this.pendingRequests.set(requestId, resolver);
  }

  /** Reject all pending requests — call on transport close. */
  rejectAllPending(reason?: string): void {
    for (const [id] of this.pendingRequests) {
      this.pendingRequests.delete(id);
    }
    void reason;
  }
}
