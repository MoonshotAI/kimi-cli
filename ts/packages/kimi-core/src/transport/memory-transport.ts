/**
 * MemoryTransport — in-process dual-queue transport (§9-D.2).
 *
 * Used for testing and in-process embedding. `createLinkedTransportPair()`
 * creates two MemoryTransport instances wired so A.send → B.onMessage and
 * B.send → A.onMessage. Uses `queueMicrotask` for async delivery to avoid
 * stack recursion.
 *
 * Close semantics (S5-M-2): after `close()`, no pending frames queued prior
 * to close may still be delivered. We track in-flight sends as cancellable
 * tickets and drop them when either end transitions to closed before the
 * microtask fires.
 */

import { TransportClosedError } from './errors.js';
import type { Transport, TransportState } from './types.js';

interface PendingDelivery {
  cancelled: boolean;
}

export class MemoryTransport implements Transport {
  private _state: TransportState = 'idle';

  get state(): TransportState {
    return this._state;
  }

  onMessage: ((frame: string) => void) | null = null;
  onConnect: (() => void) | null = null;
  onClose: ((code?: number) => void) | null = null;
  onError: ((error: Error) => void) | null = null;

  /** The peer transport — set by `createLinkedTransportPair`. */
  _peer: MemoryTransport | null = null;

  /** Outgoing deliveries from this transport that have not yet fired. */
  private _pendingOutgoing = new Set<PendingDelivery>();

  async connect(): Promise<void> {
    if (this._state !== 'idle') {
      if (this._state === 'connected') {
        return;
      }
      throw new Error(`MemoryTransport: cannot connect in state '${this._state}'`);
    }
    this._state = 'connected';
    this.onConnect?.();
  }

  async send(frame: string): Promise<void> {
    if (this._state !== 'connected') {
      throw new TransportClosedError(`MemoryTransport: cannot send in state '${this._state}'`);
    }
    const peer = this._peer;
    if (!peer) {
      return;
    }
    const ticket: PendingDelivery = { cancelled: false };
    this._pendingOutgoing.add(ticket);
    queueMicrotask(() => {
      // Remove bookkeeping regardless of delivery outcome.
      this._pendingOutgoing.delete(ticket);
      if (ticket.cancelled) {
        return;
      }
      // Re-check both sides are still connected at delivery time —
      // the sender may have closed after send() returned, or the peer
      // may have closed independently.
      if (this._state !== 'connected' || peer._state !== 'connected') {
        return;
      }
      peer.onMessage?.(frame);
    });
  }

  async close(): Promise<void> {
    if (this._state === 'closed') {
      return;
    }
    this._state = 'closed';

    // Cancel all in-flight outgoing deliveries queued before close.
    for (const ticket of this._pendingOutgoing) {
      ticket.cancelled = true;
    }
    this._pendingOutgoing.clear();

    this.onClose?.();

    const peer = this._peer;
    if (peer && peer._state !== 'closed') {
      // Propagate close to peer symmetrically: cancel its pending outgoing
      // so neither direction can deliver a pre-close frame after close.
      peer._state = 'closed';
      for (const ticket of peer._pendingOutgoing) {
        ticket.cancelled = true;
      }
      peer._pendingOutgoing.clear();
      queueMicrotask(() => {
        peer.onClose?.();
      });
    }
  }
}

/**
 * Creates a linked pair of MemoryTransport instances.
 * A.send → B.onMessage, B.send → A.onMessage.
 */
export function createLinkedTransportPair(): [MemoryTransport, MemoryTransport] {
  const a = new MemoryTransport();
  const b = new MemoryTransport();
  a._peer = b;
  b._peer = a;
  return [a, b];
}
