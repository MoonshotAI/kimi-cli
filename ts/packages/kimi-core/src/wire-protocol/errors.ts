/**
 * Wire protocol errors (Slice 5 scope).
 *
 * Custom error classes used by WireCodec/Schema validation so that transport
 * and router layers can distinguish malformed envelopes from JSON parse errors
 * or unknown-method routing errors.
 */

export class InvalidWireEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWireEnvelopeError';
  }
}

export class MalformedWireFrameError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MalformedWireFrameError';
  }
}

/**
 * Phase 21 review hotfix — the router throws this when an incoming request
 * references a method that has no registered handler. It maps to
 * JSON-RPC `-32601 Method not found`, which is the code wire clients
 * (including our E2E production-surface test) key off to distinguish
 * "method actually missing from the server" from "method is wired but
 * its handler threw".
 *
 * The previous behaviour threw a generic `Error('Method not found:
 * …')`, which `mapToWireError` silently collapsed into `-32603
 * Internal error`. That hid the Phase 18 §A merge regression and
 * would have hidden any future drop too.
 */
export class WireMethodNotFoundError extends Error {
  readonly method: string;
  constructor(method: string) {
    super(`Method not found: ${method}`);
    this.name = 'WireMethodNotFoundError';
    this.method = method;
  }
}

/**
 * Phase 21 review hotfix — thrown when a wire request references a
 * session id that is not currently loaded in SessionManager. Maps to
 * `-32000` (the pre-Phase-21 session-scoped error slot asserted by
 * wire-errors.test.ts / wire-protocol.test.ts). Previously this was a
 * generic Error → `-32603`, which made distinguishing "session gone"
 * from "handler exploded" hard for clients.
 */
export class WireSessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'WireSessionNotFoundError';
    this.sessionId = sessionId;
  }
}
