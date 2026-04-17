/**
 * WireCodec edge-case unit tests (Phase 10 B).
 *
 * Phase 10 target — `src/wire-protocol/codec.ts` coverage ≥80%.
 * Covers:
 *   - Decode: empty string / whitespace / non-object JSON (array / null /
 *     number / boolean) → MalformedWireFrameError
 *   - Decode: valid JSON with invalid envelope shape →
 *     InvalidWireEnvelopeError
 *   - Decode: invalid JSON parse failure preserves the JSON error as `cause`
 *   - Encode: no trailing newline, omits undefined fields
 *   - Round-trip across all five method categories
 */

import { describe, expect, it } from 'vitest';

import {
  createWireEvent,
  createWireRequest,
  createWireResponse,
  InvalidWireEnvelopeError,
  MalformedWireFrameError,
  WireCodec,
  type WireMessage,
} from '../../src/wire-protocol/index.js';

const codec = new WireCodec();

describe('WireCodec.decode — malformed JSON inputs', () => {
  it('throws MalformedWireFrameError on empty string', () => {
    expect(() => codec.decode('')).toThrow(MalformedWireFrameError);
  });

  it('throws MalformedWireFrameError on pure whitespace', () => {
    expect(() => codec.decode('   \t\n  ')).toThrow(MalformedWireFrameError);
  });

  it('throws MalformedWireFrameError on unterminated string', () => {
    expect(() => codec.decode('{"foo":')).toThrow(MalformedWireFrameError);
  });

  it('MalformedWireFrameError preserves the underlying cause', () => {
    try {
      codec.decode('not json');
      expect.fail('decode should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MalformedWireFrameError);
      const cause = (error as MalformedWireFrameError).cause;
      expect(cause).toBeDefined();
      expect(cause).toBeInstanceOf(Error);
    }
  });
});

describe('WireCodec.decode — non-object JSON bodies', () => {
  it('throws InvalidWireEnvelopeError on array JSON', () => {
    expect(() => codec.decode('[1,2,3]')).toThrow(InvalidWireEnvelopeError);
  });

  it('throws InvalidWireEnvelopeError on null JSON', () => {
    expect(() => codec.decode('null')).toThrow(InvalidWireEnvelopeError);
  });

  it('throws InvalidWireEnvelopeError on number JSON', () => {
    expect(() => codec.decode('42')).toThrow(InvalidWireEnvelopeError);
  });

  it('throws InvalidWireEnvelopeError on boolean JSON', () => {
    expect(() => codec.decode('true')).toThrow(InvalidWireEnvelopeError);
  });

  it('throws InvalidWireEnvelopeError on string JSON', () => {
    expect(() => codec.decode('"hello"')).toThrow(InvalidWireEnvelopeError);
  });
});

describe('WireCodec.decode — valid JSON, invalid envelope', () => {
  it('rejects envelope missing time', () => {
    const frame = JSON.stringify({
      id: 'req_aa',
      session_id: '__process__',
      type: 'request',
      from: 'client',
      to: 'core',
      method: 'initialize',
    });
    expect(() => codec.decode(frame)).toThrow(InvalidWireEnvelopeError);
  });

  it('rejects envelope with unknown id prefix', () => {
    const frame = JSON.stringify({
      id: 'bogus_aa',
      time: Date.now(),
      session_id: '__process__',
      type: 'request',
      from: 'client',
      to: 'core',
      method: 'initialize',
    });
    expect(() => codec.decode(frame)).toThrow(InvalidWireEnvelopeError);
  });

  it('rejects envelope with non-positive time', () => {
    const frame = JSON.stringify({
      id: 'req_bb',
      time: -1,
      session_id: '__process__',
      type: 'request',
      from: 'client',
      to: 'core',
      method: 'initialize',
    });
    expect(() => codec.decode(frame)).toThrow(InvalidWireEnvelopeError);
  });

  it('rejects request envelope missing method', () => {
    const frame = JSON.stringify({
      id: 'req_cc',
      time: Date.now(),
      session_id: '__process__',
      type: 'request',
      from: 'client',
      to: 'core',
    });
    expect(() => codec.decode(frame)).toThrow(InvalidWireEnvelopeError);
  });

  it('rejects response envelope missing request_id', () => {
    const frame = JSON.stringify({
      id: 'res_dd',
      time: Date.now(),
      session_id: 'ses_x',
      type: 'response',
      from: 'core',
      to: 'client',
      data: { ok: true },
    });
    expect(() => codec.decode(frame)).toThrow(InvalidWireEnvelopeError);
  });

  it('rejects event envelope missing seq', () => {
    const frame = JSON.stringify({
      id: 'evt_ee',
      time: Date.now(),
      session_id: 'ses_x',
      type: 'event',
      from: 'core',
      to: 'client',
      method: 'turn.begin',
    });
    expect(() => codec.decode(frame)).toThrow(InvalidWireEnvelopeError);
  });
});

describe('WireCodec.encode — framing discipline', () => {
  it('produces JSON without trailing newline', () => {
    const msg: WireMessage = createWireRequest({
      method: 'initialize',
      sessionId: '__process__',
    });
    const frame = codec.encode(msg);
    expect(frame.endsWith('\n')).toBe(false);
    expect(frame.endsWith('\r')).toBe(false);
  });

  it('omits undefined optional fields from the serialized frame', () => {
    const msg: WireMessage = createWireRequest({
      method: 'initialize',
      sessionId: '__process__',
    });
    const frame = codec.encode(msg);
    const parsed = JSON.parse(frame) as Record<string, unknown>;
    expect('turn_id' in parsed).toBe(false);
    expect('agent_type' in parsed).toBe(false);
    expect('seq' in parsed).toBe(false);
    expect('data' in parsed).toBe(false);
    expect('error' in parsed).toBe(false);
  });

  it('keeps all wire envelope required fields present', () => {
    const msg: WireMessage = createWireRequest({
      method: 'shutdown',
      sessionId: '__process__',
    });
    const frame = codec.encode(msg);
    const parsed = JSON.parse(frame) as Record<string, unknown>;
    for (const field of ['id', 'time', 'session_id', 'type', 'from', 'to', 'method']) {
      expect(field in parsed).toBe(true);
    }
  });
});

describe('WireCodec — round-trip for every method category', () => {
  it('round-trips a process method (initialize)', () => {
    const original = createWireRequest({
      method: 'initialize',
      sessionId: '__process__',
      data: { protocol_version: '2.1' },
    });
    expect(codec.decode(codec.encode(original))).toEqual(original);
  });

  it('round-trips a conversation method (session.prompt)', () => {
    const original = createWireRequest({
      method: 'session.prompt',
      sessionId: 'ses_rt',
      data: { input: 'hello' },
    });
    expect(codec.decode(codec.encode(original))).toEqual(original);
  });

  it('round-trips a management method (session.getStatus)', () => {
    const original = createWireRequest({
      method: 'session.getStatus',
      sessionId: 'ses_rt',
    });
    expect(codec.decode(codec.encode(original))).toEqual(original);
  });

  it('round-trips a config method (session.setModel)', () => {
    const original = createWireRequest({
      method: 'session.setModel',
      sessionId: 'ses_rt',
      data: { model: 'test-model' },
    });
    expect(codec.decode(codec.encode(original))).toEqual(original);
  });

  it('round-trips a tools method (session.listTools)', () => {
    const original = createWireRequest({
      method: 'session.listTools',
      sessionId: 'ses_rt',
    });
    expect(codec.decode(codec.encode(original))).toEqual(original);
  });

  it('round-trips a reverse-RPC request (approval.request)', () => {
    const original = createWireRequest({
      method: 'approval.request',
      sessionId: 'ses_rt',
      from: 'core',
      to: 'client',
      data: { id: 'apr_1' },
    });
    expect(codec.decode(codec.encode(original))).toEqual(original);
  });

  it('round-trips a response envelope with error', () => {
    const original = createWireResponse({
      requestId: 'req_err',
      sessionId: 'ses_rt',
      error: { code: -32601, message: 'Method not found' },
    });
    expect(codec.decode(codec.encode(original))).toEqual(original);
  });

  it('round-trips an event envelope with turn_id + agent_type', () => {
    const original = createWireEvent({
      method: 'turn.begin',
      sessionId: 'ses_rt',
      seq: 1,
      turnId: 'turn_1',
      agentType: 'main',
      data: { turn_id: 'turn_1', user_input: 'hi', input_kind: 'user' },
    });
    expect(codec.decode(codec.encode(original))).toEqual(original);
  });
});
