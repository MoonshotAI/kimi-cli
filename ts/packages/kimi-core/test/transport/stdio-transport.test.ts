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

  // ── UTF-8 stream decoding (S5-M-3 regression) ──

  it('reassembles a Chinese character split across two chunks', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioTransport({ stdin, stdout });
    const received: string[] = [];
    transport.onMessage = (frame) => received.push(frame);

    await transport.connect();

    // "你" is 3 bytes in UTF-8: E4 BD A0. Split as 1 + 2.
    const char = Buffer.from('你', 'utf-8');
    expect(char.length).toBe(3);
    stdin.write(char.subarray(0, 1));
    stdin.write(Buffer.concat([char.subarray(1), Buffer.from('\n', 'utf-8')]));

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(received).toEqual(['你']);
  });

  it('reassembles an emoji split 2+2 across chunks', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioTransport({ stdin, stdout });
    const received: string[] = [];
    transport.onMessage = (frame) => received.push(frame);

    await transport.connect();

    // "🙂" (U+1F642) is 4 bytes in UTF-8: F0 9F 99 82. Split 2+2.
    const emoji = Buffer.from('🙂', 'utf-8');
    expect(emoji.length).toBe(4);
    stdin.write(emoji.subarray(0, 2));
    stdin.write(Buffer.concat([emoji.subarray(2), Buffer.from('\n', 'utf-8')]));

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(received).toEqual(['🙂']);
  });

  it('reassembles an emoji split 1+3 across chunks', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioTransport({ stdin, stdout });
    const received: string[] = [];
    transport.onMessage = (frame) => received.push(frame);

    await transport.connect();

    const emoji = Buffer.from('🙂', 'utf-8');
    stdin.write(emoji.subarray(0, 1));
    stdin.write(Buffer.concat([emoji.subarray(1), Buffer.from('\n', 'utf-8')]));

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(received).toEqual(['🙂']);
  });

  it('reassembles an emoji split 3+1 across chunks', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioTransport({ stdin, stdout });
    const received: string[] = [];
    transport.onMessage = (frame) => received.push(frame);

    await transport.connect();

    const emoji = Buffer.from('🙂', 'utf-8');
    stdin.write(emoji.subarray(0, 3));
    stdin.write(Buffer.concat([emoji.subarray(3), Buffer.from('\n', 'utf-8')]));

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(received).toEqual(['🙂']);
  });

  it('delivers JSON containing multi-byte UTF-8 when split mid-char', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioTransport({ stdin, stdout });
    const received: string[] = [];
    transport.onMessage = (frame) => received.push(frame);

    await transport.connect();

    // Frame: {"msg":"你好🙂"}\n
    const frame = Buffer.from('{"msg":"你好🙂"}\n', 'utf-8');
    // Split mid-character: 10 bytes + rest
    stdin.write(frame.subarray(0, 10));
    stdin.write(frame.subarray(10));

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toBe('{"msg":"你好🙂"}');
    expect(JSON.parse(received[0] as string)).toEqual({ msg: '你好🙂' });
  });

  it('passes ASCII unchanged through the decoder', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioTransport({ stdin, stdout });
    const received: string[] = [];
    transport.onMessage = (frame) => received.push(frame);

    await transport.connect();

    stdin.write(Buffer.from('{"ascii":"hello"}\n', 'utf-8'));

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(received).toEqual(['{"ascii":"hello"}']);
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
