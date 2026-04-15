/**
 * MemoryTransport — in-process dual-queue transport (§9-D.2).
 *
 * Used for testing and in-process embedding. `createLinkedTransportPair()`
 * creates two MemoryTransport instances wired so A.send → B.onMessage and
 * B.send → A.onMessage. Uses `queueMicrotask` for async delivery to avoid
 * stack recursion.
 */

import type { Transport, TransportState } from './types.js';

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
      throw new Error(`MemoryTransport: cannot send in state '${this._state}'`);
    }
    const peer = this._peer;
    if (peer) {
      queueMicrotask(() => {
        peer.onMessage?.(frame);
      });
    }
  }

  async close(): Promise<void> {
    if (this._state === 'closed') {
      return;
    }
    this._state = 'closed';
    this.onClose?.();
    // Notify peer and transition peer to closed
    const peer = this._peer;
    if (peer && peer._state !== 'closed') {
      peer._state = 'closed';
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
