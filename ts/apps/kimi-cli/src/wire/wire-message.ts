/**
 * WireMessage -- unified message envelope for Wire Protocol 2.1.
 *
 * All messages (requests, responses, events) share this single envelope.
 * The `type` field discriminates the three categories; `method` identifies
 * the specific operation or event kind.
 *
 * Field naming uses snake_case to match the JSON wire format.
 */

// ── Wire Error ──────────────────────────────────────────────────────

export interface WireError {
  code: number;
  message: string;
  details?: unknown;
}

// ── WireMessage ─────────────────────────────────────────────────────

export interface WireMessage {
  /** Unique ID with prefix: req_xxx / res_xxx / evt_xxx. */
  id: string;
  /** Unix millisecond timestamp. */
  time: number;
  /** Multi-session routing key. Process-level methods use "__process__". */
  session_id: string;
  /** Message category. */
  type: 'request' | 'response' | 'event';
  /** Sender identifier: "client" / "core" / "sub:<id>". */
  from: string;
  /** Receiver identifier: "core" / "client" / "sub:<id>". */
  to: string;

  /** Method name (for request and event). */
  method?: string | undefined;
  /** Associated request ID (for response). */
  request_id?: string | undefined;
  /** Payload data. */
  data?: unknown;
  /** Error information (for response). */
  error?: WireError | undefined;

  /** Turn identifier, e.g. "turn_1", "turn_42". */
  turn_id?: string | undefined;
  /** Agent type discriminator. */
  agent_type?: 'main' | 'sub' | 'independent' | undefined;
  /** Monotonically increasing event sequence number. */
  seq?: number | undefined;
}

// ── Protocol Version ────────────────────────────────────────────────

export const WIRE_PROTOCOL_VERSION = '2.1';

// ── ID Generators ───────────────────────────────────────────────────

let _counter = 0;

function nextId(prefix: string): string {
  _counter += 1;
  return `${prefix}_${_counter.toString(36)}`;
}

/** Reset the internal counter (for testing). */
export function _resetIdCounter(): void {
  _counter = 0;
}

// ── Factory Option Types ────────────────────────────────────────────

export interface EventOpts {
  session_id: string;
  from?: string | undefined;
  to?: string | undefined;
  turn_id?: string | undefined;
  agent_type?: 'main' | 'sub' | 'independent' | undefined;
  seq?: number | undefined;
}

export interface RequestOpts {
  session_id: string;
  from?: string | undefined;
  to?: string | undefined;
  turn_id?: string | undefined;
}

export interface ResponseOpts {
  session_id: string;
  from?: string | undefined;
  to?: string | undefined;
}

// ── Factory Functions ───────────────────────────────────────────────

/** Create an event message. */
export function createEvent(
  method: string,
  data: unknown,
  opts: EventOpts,
): WireMessage {
  return {
    id: nextId('evt'),
    time: Date.now(),
    session_id: opts.session_id,
    type: 'event',
    from: opts.from ?? 'core',
    to: opts.to ?? 'client',
    method,
    data,
    turn_id: opts.turn_id,
    agent_type: opts.agent_type,
    seq: opts.seq,
  };
}

/** Create a request message. */
export function createRequest(
  method: string,
  data: unknown,
  opts: RequestOpts,
): WireMessage {
  return {
    id: nextId('req'),
    time: Date.now(),
    session_id: opts.session_id,
    type: 'request',
    from: opts.from ?? 'client',
    to: opts.to ?? 'core',
    method,
    data,
    turn_id: opts.turn_id,
  };
}

/** Create a successful response message. */
export function createResponse(
  requestId: string,
  data: unknown,
  opts: ResponseOpts,
): WireMessage {
  return {
    id: nextId('res'),
    time: Date.now(),
    session_id: opts.session_id,
    type: 'response',
    from: opts.from ?? 'core',
    to: opts.to ?? 'client',
    request_id: requestId,
    data,
  };
}

/** Create an error response message. */
export function createErrorResponse(
  requestId: string,
  error: WireError,
  opts: ResponseOpts,
): WireMessage {
  return {
    id: nextId('res'),
    time: Date.now(),
    session_id: opts.session_id,
    type: 'response',
    from: opts.from ?? 'core',
    to: opts.to ?? 'client',
    request_id: requestId,
    error,
  };
}
