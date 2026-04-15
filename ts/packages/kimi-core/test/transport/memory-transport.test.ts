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

import { MemoryTransport, createLinkedTransportPair } from '../../src/transport/index.js';

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
