/**
 * Transport layer — type definitions (Slice 5 scope, §9-D).
 *
 * Transport is a pure bidirectional frame channel. It knows nothing about
 * message semantics (WireCodec) or routing (Router).
 *
 * State machine: idle → connecting → connected → closing → closed (terminal).
 * Reconnect = create a new Transport instance.
 */

// ── Transport state machine ─────────────────────────────────────────────

export type TransportState = 'idle' | 'connecting' | 'connected' | 'closing' | 'closed';

// ── Transport interface (§9-D.1) ────────────────────────────────────────

export interface Transport {
  readonly state: TransportState;
  connect(): Promise<void>;
  send(frame: string): Promise<void>;
  close(): Promise<void>;
  onMessage: ((frame: string) => void) | null;
  onConnect: (() => void) | null;
  onClose: ((code?: number) => void) | null;
  onError: ((error: Error) => void) | null;
}

// ── TransportServer interface (§9-D.1) ──────────────────────────────────

export interface TransportServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  onConnection: ((transport: Transport) => void) | null;
}
