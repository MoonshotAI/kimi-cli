/**
 * StdioTransport — NDJSON stdin/stdout transport tests.
 *
 * New v2-only tests — Python tests used subprocess stdin/stdout via
 * wire_helpers but never tested transport layer in isolation. These test
 * the StdioTransport state machine and NDJSON framing per §9-D.2.
 *
 * All tests FAIL (red bar) until Slice 5 Phase 3 implementation.
 */

import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { StdioTransport } from '../../src/transport/index.js';

// ── State machine ────────────────────────────────────────────────────────

describe('StdioTransport state machine', () => {
  it('starts in idle state', () => {
    const transport = new StdioTransport();
    expect(transport.state).toBe('idle');
  });

  it('transitions to connected after connect()', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioTransport({ stdin, stdout });
    await transport.connect();
    expect(transport.state).toBe('connected');
  });

  it('transitions to closed after close()', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioTransport({ stdin, stdout });
    await transport.connect();
    await transport.close();
    expect(transport.state).toBe('closed');
  });
});

// ── NDJSON framing ───────────────────────────────────────────────────────

describe('StdioTransport NDJSON', () => {
  it('send() writes JSON + newline to stdout', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioTransport({ stdin, stdout });
    await transport.connect();

    const chunks: Buffer[] = [];
    stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

    await transport.send('{"hello":"world"}');

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    const written = Buffer.concat(chunks).toString('utf-8');
    expect(written).toBe('{"hello":"world"}\n');
  });

  it('receives NDJSON lines from stdin as onMessage', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioTransport({ stdin, stdout });
    const received: string[] = [];
    transport.onMessage = (frame) => received.push(frame);

    await transport.connect();

    stdin.write('{"id":"req_001"}\n');
    stdin.write('{"id":"req_002"}\n');

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(received).toHaveLength(2);
    expect(received[0]).toBe('{"id":"req_001"}');
    expect(received[1]).toBe('{"id":"req_002"}');
  });

  it('handles partial line buffering', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioTransport({ stdin, stdout });
    const received: string[] = [];
    transport.onMessage = (frame) => received.push(frame);

    await transport.connect();

    // Write a message in two chunks (split mid-JSON)
    stdin.write('{"id":');
    stdin.write('"req_003"}\n');

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toBe('{"id":"req_003"}');
  });

  it('ignores blank lines', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioTransport({ stdin, stdout });
    const received: string[] = [];
    transport.onMessage = (frame) => received.push(frame);

    await transport.connect();

    stdin.write('\n\n{"id":"req_004"}\n\n');

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toBe('{"id":"req_004"}');
  });

  it('fires onClose when stdin ends', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioTransport({ stdin, stdout });
    let closed = false;
    transport.onClose = () => {
      closed = true;
    };

    await transport.connect();
    stdin.end();

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(closed).toBe(true);
  });
});
