/**
 * MemoryTransport — in-process linked pair transport tests.
 *
 * New v2-only tests — Python had no direct transport unit tests (transport
 * was subprocess-based). These test the MemoryTransport state machine and
 * linked pair delivery semantics per §9-D.2.
 *
 * All tests FAIL (red bar) until Slice 5 Phase 3 implementation.
 */

import { describe, expect, it } from 'vitest';

import {
  MemoryTransport,
  TransportClosedError,
  createLinkedTransportPair,
} from '../../src/transport/index.js';

// ── State machine ────────────────────────────────────────────────────────

describe('MemoryTransport state machine', () => {
  it('starts in idle state', () => {
    const transport = new MemoryTransport();
    expect(transport.state).toBe('idle');
  });

  it('transitions to connected after connect()', async () => {
    const transport = new MemoryTransport();
    await transport.connect();
    expect(transport.state).toBe('connected');
  });

  it('transitions to closed after close()', async () => {
    const transport = new MemoryTransport();
    await transport.connect();
    await transport.close();
    expect(transport.state).toBe('closed');
  });

  it('rejects send() when not connected', async () => {
    const transport = new MemoryTransport();
    await expect(transport.send('hello')).rejects.toThrow();
  });

  it('rejects send() after close()', async () => {
    const transport = new MemoryTransport();
    await transport.connect();
    await transport.close();
    await expect(transport.send('hello')).rejects.toThrow();
  });

  it('close() from idle is a no-op transition to closed', async () => {
    const transport = new MemoryTransport();
    await transport.close();
    expect(transport.state).toBe('closed');
  });

  it('double close() does not throw', async () => {
    const transport = new MemoryTransport();
    await transport.connect();
    await transport.close();
    await expect(transport.close()).resolves.toBeUndefined();
  });
});

// ── Linked pair delivery ─────────────────────────────────────────────────

describe('createLinkedTransportPair', () => {
  it('creates two transport instances', () => {
    const [a, b] = createLinkedTransportPair();
    expect(a).toBeInstanceOf(MemoryTransport);
    expect(b).toBeInstanceOf(MemoryTransport);
    expect(a).not.toBe(b);
  });

  it('A.send delivers to B.onMessage', async () => {
    const [a, b] = createLinkedTransportPair();
    const received: string[] = [];
    b.onMessage = (frame) => received.push(frame);

    await a.connect();
    await b.connect();
    await a.send('hello from A');

    // queueMicrotask delivery — wait a tick
    await new Promise<void>((resolve) => {
      queueMicrotask(() => {
        resolve();
      });
    });
    expect(received).toEqual(['hello from A']);
  });

  it('B.send delivers to A.onMessage', async () => {
    const [a, b] = createLinkedTransportPair();
    const received: string[] = [];
    a.onMessage = (frame) => received.push(frame);

    await a.connect();
    await b.connect();
    await b.send('hello from B');

    await new Promise<void>((resolve) => {
      queueMicrotask(() => {
        resolve();
      });
    });
    expect(received).toEqual(['hello from B']);
  });

  it('delivers multiple messages in order', async () => {
    const [a, b] = createLinkedTransportPair();
    const received: string[] = [];
    b.onMessage = (frame) => received.push(frame);

    await a.connect();
    await b.connect();
    await a.send('msg1');
    await a.send('msg2');
    await a.send('msg3');

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(received).toEqual(['msg1', 'msg2', 'msg3']);
  });

  it('bidirectional delivery works simultaneously', async () => {
    const [a, b] = createLinkedTransportPair();
    const receivedByA: string[] = [];
    const receivedByB: string[] = [];
    a.onMessage = (frame) => receivedByA.push(frame);
    b.onMessage = (frame) => receivedByB.push(frame);

    await a.connect();
    await b.connect();
    await a.send('A→B');
    await b.send('B→A');

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(receivedByA).toEqual(['B→A']);
    expect(receivedByB).toEqual(['A→B']);
  });

  it('closing A triggers B.onClose', async () => {
    const [a, b] = createLinkedTransportPair();
    let closeCalled = false;
    b.onClose = () => {
      closeCalled = true;
    };

    await a.connect();
    await b.connect();
    await a.close();

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(closeCalled).toBe(true);
  });

  it('does not deliver to null onMessage', async () => {
    const [a, b] = createLinkedTransportPair();
    b.onMessage = null;

    await a.connect();
    await b.connect();

    // Should not throw
    await expect(a.send('ignored')).resolves.toBeUndefined();
  });

  // ── Close race (S5-M-2 regression) ──
  //
  // The race scenario (per audit): caller fires send() and close() in the
  // same synchronous block, without awaiting the send. close() must cancel
  // the queued delivery before its microtask fires. We intentionally skip
  // `await` on send() because awaiting yields to the microtask queue and
  // would let the stale delivery fire before close() even starts — that
  // case is philosophically "delivery already happened".

  it('send() → close() (no await) does not deliver pre-close frames to peer', async () => {
    const [a, b] = createLinkedTransportPair();
    const received: string[] = [];
    b.onMessage = (frame) => received.push(frame);

    await a.connect();
    await b.connect();

    const sendPromise = a.send('ghost_frame');
    await a.close();
    await sendPromise;

    // Wait several microtasks + macrotask to let any stale deliveries fire.
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(received).toEqual([]);
  });

  it('close() on sender cancels peer-to-sender pending deliveries', async () => {
    const [a, b] = createLinkedTransportPair();
    const receivedByA: string[] = [];
    a.onMessage = (frame) => receivedByA.push(frame);

    await a.connect();
    await b.connect();

    // B queues a frame for A, then A closes before microtask fires.
    const sendPromise = b.send('B→A_ghost');
    await a.close();
    await sendPromise;

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(receivedByA).toEqual([]);
  });

  it('send() after close() rejects with TransportClosedError', async () => {
    const transport = new MemoryTransport();
    await transport.connect();
    await transport.close();

    await expect(transport.send('after_close')).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('closing one end transitions peer to closed', async () => {
    const [a, b] = createLinkedTransportPair();
    await a.connect();
    await b.connect();

    await a.close();

    // Peer synchronously transitions to closed so subsequent sends reject.
    expect(b.state).toBe('closed');
    await expect(b.send('after_peer_close')).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('close() fires peer.onClose exactly once', async () => {
    const [a, b] = createLinkedTransportPair();
    let bCloseCalls = 0;
    b.onClose = () => {
      bCloseCalls += 1;
    };

    await a.connect();
    await b.connect();
    await a.close();
    await a.close(); // double close is no-op

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(bCloseCalls).toBe(1);
  });

  it('multiple queued sends before close all get dropped', async () => {
    const [a, b] = createLinkedTransportPair();
    const received: string[] = [];
    b.onMessage = (frame) => received.push(frame);

    await a.connect();
    await b.connect();

    const p1 = a.send('m1');
    const p2 = a.send('m2');
    const p3 = a.send('m3');
    await a.close();
    await Promise.all([p1, p2, p3]);

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(received).toEqual([]);
  });
});

// ── Callbacks ────────────────────────────────────────────────────────────

describe('MemoryTransport callbacks', () => {
  it('fires onConnect when connect() succeeds', async () => {
    const transport = new MemoryTransport();
    let connected = false;
    transport.onConnect = () => {
      connected = true;
    };
    await transport.connect();
    expect(connected).toBe(true);
  });

  it('fires onClose when close() is called', async () => {
    const transport = new MemoryTransport();
    let closed = false;
    transport.onClose = () => {
      closed = true;
    };
    await transport.connect();
    await transport.close();
    expect(closed).toBe(true);
  });
});
