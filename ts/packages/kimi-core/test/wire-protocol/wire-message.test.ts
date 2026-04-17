/**
 * Wire protocol 2.1 — envelope, codec, factory, and schema tests.
 *
 * Rewritten from Python `tests/core/test_wire_message.py` (serde, validation,
 * type predicates) + v2-only tests for WireCodec and message factory. All
 * tests pass as of Phase 10 (src/wire-protocol/ 100% v8 coverage); Phase 10
 * extended this file with +6 superRefine negative cases (empty from/to /
 * session_id, invalid agent_type, non-integer seq, non-number error.code).
 */

import { describe, expect, it } from 'vitest';

import {
  type WireEvent,
  type WireMessage,
  type WireRequest,
  type WireResponse,
  InvalidWireEnvelopeError,
  MalformedWireFrameError,
  PROCESS_SESSION_ID,
  WIRE_PROTOCOL_VERSION,
  WireCodec,
  WireMessageSchema,
  createWireEvent,
  createWireRequest,
  createWireResponse,
} from '../../src/wire-protocol/index.js';

// ── Protocol constants ───────────────────────────────────────────────────

describe('Wire protocol constants', () => {
  it('protocol version is 2.1', () => {
    expect(WIRE_PROTOCOL_VERSION).toBe('2.1');
  });

  it('process session ID is __process__', () => {
    expect(PROCESS_SESSION_ID).toBe('__process__');
  });
});

// ── WireMessage zod schema (rewrite of test_wire_message_serde) ─────────

describe('WireMessageSchema', () => {
  it('parses a valid request envelope', () => {
    const raw = {
      id: 'req_001',
      time: Date.now(),
      session_id: '__process__',
      type: 'request',
      from: 'client',
      to: 'core',
      method: 'initialize',
      data: { protocol_version: '2.1' },
    };
    const result = WireMessageSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('request');
      expect(result.data.method).toBe('initialize');
    }
  });

  it('parses a valid response envelope', () => {
    const raw = {
      id: 'res_001',
      time: Date.now(),
      session_id: '__process__',
      type: 'response',
      from: 'core',
      to: 'client',
      request_id: 'req_001',
      data: { protocol_version: '2.1', capabilities: {} },
    };
    const result = WireMessageSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('response');
      expect(result.data.request_id).toBe('req_001');
    }
  });

  it('parses a valid event envelope', () => {
    const raw = {
      id: 'evt_001',
      time: Date.now(),
      session_id: 'ses_abc',
      type: 'event',
      from: 'core',
      to: 'client',
      method: 'turn.begin',
      seq: 1,
      turn_id: 'turn_1',
      agent_type: 'main',
      data: { turn_id: 'turn_1', user_input: 'hello', input_kind: 'user' },
    };
    const result = WireMessageSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('event');
      expect(result.data.seq).toBe(1);
      expect(result.data.turn_id).toBe('turn_1');
    }
  });

  it('rejects envelope missing required fields', () => {
    const raw = { id: 'req_001', type: 'request' };
    const result = WireMessageSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('rejects envelope with invalid type', () => {
    const raw = {
      id: 'req_001',
      time: Date.now(),
      session_id: '__process__',
      type: 'invalid',
      from: 'client',
      to: 'core',
    };
    const result = WireMessageSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('parses envelope with error field', () => {
    const raw = {
      id: 'res_002',
      time: Date.now(),
      session_id: 'ses_abc',
      type: 'response',
      from: 'core',
      to: 'client',
      request_id: 'req_002',
      error: { code: -32600, message: 'Session not found' },
    };
    const result = WireMessageSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.error?.code).toBe(-32600);
      expect(result.data.error?.message).toBe('Session not found');
    }
  });

  it('accepts optional fields as absent', () => {
    const raw = {
      id: 'req_003',
      time: Date.now(),
      session_id: '__process__',
      type: 'request',
      from: 'client',
      to: 'core',
      method: 'shutdown',
    };
    const result = WireMessageSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.turn_id).toBeUndefined();
      expect(result.data.agent_type).toBeUndefined();
      expect(result.data.seq).toBeUndefined();
    }
  });

  // ── Conditional required fields (S5-M-1 regression) ──

  it('rejects request envelope missing method', () => {
    const raw = {
      id: 'req_100',
      time: Date.now(),
      session_id: '__process__',
      type: 'request',
      from: 'client',
      to: 'core',
      // method absent
    };
    const result = WireMessageSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('rejects request envelope with empty-string method', () => {
    const raw = {
      id: 'req_101',
      time: Date.now(),
      session_id: '__process__',
      type: 'request',
      from: 'client',
      to: 'core',
      method: '',
    };
    const result = WireMessageSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('rejects response envelope missing request_id', () => {
    const raw = {
      id: 'res_100',
      time: Date.now(),
      session_id: 'ses_abc',
      type: 'response',
      from: 'core',
      to: 'client',
      // request_id absent
      data: { ok: true },
    };
    const result = WireMessageSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('rejects response envelope with empty-string request_id', () => {
    const raw = {
      id: 'res_101',
      time: Date.now(),
      session_id: 'ses_abc',
      type: 'response',
      from: 'core',
      to: 'client',
      request_id: '',
    };
    const result = WireMessageSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('rejects event envelope missing method', () => {
    const raw = {
      id: 'evt_100',
      time: Date.now(),
      session_id: 'ses_abc',
      type: 'event',
      from: 'core',
      to: 'client',
      seq: 1,
      // method absent
    };
    const result = WireMessageSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('rejects event envelope missing seq', () => {
    const raw = {
      id: 'evt_101',
      time: Date.now(),
      session_id: 'ses_abc',
      type: 'event',
      from: 'core',
      to: 'client',
      method: 'turn.begin',
      // seq absent
    };
    const result = WireMessageSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('rejects event envelope with negative seq', () => {
    const raw = {
      id: 'evt_102',
      time: Date.now(),
      session_id: 'ses_abc',
      type: 'event',
      from: 'core',
      to: 'client',
      method: 'turn.begin',
      seq: -1,
    };
    const result = WireMessageSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('rejects envelope with wrong id prefix', () => {
    const raw = {
      id: 'bad_001',
      time: Date.now(),
      session_id: '__process__',
      type: 'request',
      from: 'client',
      to: 'core',
      method: 'initialize',
    };
    const result = WireMessageSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('rejects envelope with non-positive time', () => {
    const raw = {
      id: 'req_200',
      time: 0,
      session_id: '__process__',
      type: 'request',
      from: 'client',
      to: 'core',
      method: 'initialize',
    };
    const result = WireMessageSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('rejects envelope with non-integer time', () => {
    const raw = {
      id: 'req_201',
      time: 1.5,
      session_id: '__process__',
      type: 'request',
      from: 'client',
      to: 'core',
      method: 'initialize',
    };
    const result = WireMessageSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('accepts event envelope with seq === 0', () => {
    const raw = {
      id: 'evt_200',
      time: Date.now(),
      session_id: 'ses_abc',
      type: 'event',
      from: 'core',
      to: 'client',
      method: 'turn.begin',
      seq: 0,
    };
    const result = WireMessageSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  // ── Additional superRefine negative coverage (Phase 10 B) ──

  it('rejects envelope with empty-string from', () => {
    const raw = {
      id: 'req_300',
      time: Date.now(),
      session_id: '__process__',
      type: 'request',
      from: '',
      to: 'core',
      method: 'initialize',
    };
    expect(WireMessageSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects envelope with empty-string to', () => {
    const raw = {
      id: 'req_301',
      time: Date.now(),
      session_id: '__process__',
      type: 'request',
      from: 'client',
      to: '',
      method: 'initialize',
    };
    expect(WireMessageSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects envelope with empty-string session_id', () => {
    const raw = {
      id: 'req_302',
      time: Date.now(),
      session_id: '',
      type: 'request',
      from: 'client',
      to: 'core',
      method: 'initialize',
    };
    expect(WireMessageSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects invalid agent_type enum value', () => {
    const raw = {
      id: 'evt_400',
      time: Date.now(),
      session_id: 'ses_abc',
      type: 'event',
      from: 'core',
      to: 'client',
      method: 'turn.begin',
      seq: 1,
      agent_type: 'bogus',
    };
    expect(WireMessageSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects non-integer seq (fractional)', () => {
    const raw = {
      id: 'evt_401',
      time: Date.now(),
      session_id: 'ses_abc',
      type: 'event',
      from: 'core',
      to: 'client',
      method: 'turn.begin',
      seq: 1.5,
    };
    expect(WireMessageSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects error.code that is not a number', () => {
    const raw = {
      id: 'res_400',
      time: Date.now(),
      session_id: 'ses_abc',
      type: 'response',
      from: 'core',
      to: 'client',
      request_id: 'req_400',
      error: { code: 'oops', message: 'bad' },
    };
    expect(WireMessageSchema.safeParse(raw).success).toBe(false);
  });
});

// ── WireCodec (v2-only) ─────────────────────────────────────────────────

describe('WireCodec', () => {
  const codec = new WireCodec();

  describe('encode', () => {
    it('serializes a WireMessage to JSON string', () => {
      const msg: WireMessage = {
        id: 'req_001',
        time: 1700000000000,
        session_id: '__process__',
        type: 'request',
        from: 'client',
        to: 'core',
        method: 'initialize',
        data: { protocol_version: '2.1' },
      };
      const frame = codec.encode(msg);
      expect(typeof frame).toBe('string');
      const parsed = JSON.parse(frame) as Record<string, unknown>;
      expect(parsed['id']).toBe('req_001');
      expect(parsed['method']).toBe('initialize');
    });

    it('produces valid JSON without trailing newline', () => {
      const msg: WireMessage = {
        id: 'evt_001',
        time: 1700000000000,
        session_id: 'ses_abc',
        type: 'event',
        from: 'core',
        to: 'client',
        method: 'turn.begin',
        seq: 1,
      };
      const frame = codec.encode(msg);
      expect(frame.endsWith('\n')).toBe(false);
      expect(() => JSON.parse(frame) as unknown).not.toThrow();
    });

    it('omits undefined optional fields', () => {
      const msg: WireMessage = {
        id: 'req_002',
        time: 1700000000000,
        session_id: '__process__',
        type: 'request',
        from: 'client',
        to: 'core',
        method: 'shutdown',
      };
      const frame = codec.encode(msg);
      const parsed = JSON.parse(frame) as Record<string, unknown>;
      expect('turn_id' in parsed).toBe(false);
      expect('agent_type' in parsed).toBe(false);
    });
  });

  describe('decode', () => {
    it('deserializes a valid JSON frame to WireMessage', () => {
      const frame = JSON.stringify({
        id: 'req_001',
        time: 1700000000000,
        session_id: '__process__',
        type: 'request',
        from: 'client',
        to: 'core',
        method: 'initialize',
      });
      const msg = codec.decode(frame);
      expect(msg.id).toBe('req_001');
      expect(msg.type).toBe('request');
      expect(msg.method).toBe('initialize');
    });

    it('throws MalformedWireFrameError on invalid JSON', () => {
      expect(() => codec.decode('not json')).toThrow(MalformedWireFrameError);
    });

    it('throws InvalidWireEnvelopeError on JSON missing required fields', () => {
      const frame = JSON.stringify({ id: 'req_001' });
      expect(() => codec.decode(frame)).toThrow(InvalidWireEnvelopeError);
    });

    it('throws InvalidWireEnvelopeError for response missing request_id', () => {
      const frame = JSON.stringify({
        id: 'res_303',
        time: Date.now(),
        session_id: 'ses_abc',
        type: 'response',
        from: 'core',
        to: 'client',
        data: { ok: true },
      });
      expect(() => codec.decode(frame)).toThrow(InvalidWireEnvelopeError);
    });

    it('throws InvalidWireEnvelopeError for event missing seq', () => {
      const frame = JSON.stringify({
        id: 'evt_303',
        time: Date.now(),
        session_id: 'ses_abc',
        type: 'event',
        from: 'core',
        to: 'client',
        method: 'turn.begin',
      });
      expect(() => codec.decode(frame)).toThrow(InvalidWireEnvelopeError);
    });

    it('throws InvalidWireEnvelopeError for request missing method', () => {
      const frame = JSON.stringify({
        id: 'req_303',
        time: Date.now(),
        session_id: '__process__',
        type: 'request',
        from: 'client',
        to: 'core',
      });
      expect(() => codec.decode(frame)).toThrow(InvalidWireEnvelopeError);
    });

    it('round-trips a request message', () => {
      const original: WireMessage = {
        id: 'req_round',
        time: 1700000000000,
        session_id: 'ses_xyz',
        type: 'request',
        from: 'client',
        to: 'core',
        method: 'session.prompt',
        data: { input: 'hello' },
      };
      const roundtripped = codec.decode(codec.encode(original));
      expect(roundtripped).toEqual(original);
    });

    it('round-trips an event message with all fields', () => {
      const original: WireMessage = {
        id: 'evt_round',
        time: 1700000000000,
        session_id: 'ses_xyz',
        type: 'event',
        from: 'core',
        to: 'client',
        method: 'turn.begin',
        seq: 42,
        turn_id: 'turn_7',
        agent_type: 'main',
        data: { turn_id: 'turn_7', user_input: 'hi', input_kind: 'user' },
      };
      const roundtripped = codec.decode(codec.encode(original));
      expect(roundtripped).toEqual(original);
    });
  });
});

// ── Message factory (v2-only) ────────────────────────────────────────────

describe('createWireRequest', () => {
  it('generates an id with req_ prefix', () => {
    const msg = createWireRequest({
      method: 'initialize',
      sessionId: '__process__',
    });
    expect(msg.id).toMatch(/^req_/);
  });

  it('sets type to request', () => {
    const msg = createWireRequest({
      method: 'session.prompt',
      sessionId: 'ses_abc',
      data: { input: 'hello' },
    });
    expect(msg.type).toBe('request');
  });

  it('fills time with current timestamp', () => {
    const before = Date.now();
    const msg = createWireRequest({
      method: 'initialize',
      sessionId: '__process__',
    });
    const after = Date.now();
    expect(msg.time).toBeGreaterThanOrEqual(before);
    expect(msg.time).toBeLessThanOrEqual(after);
  });

  it('defaults from=client, to=core', () => {
    const msg = createWireRequest({
      method: 'initialize',
      sessionId: '__process__',
    });
    expect(msg.from).toBe('client');
    expect(msg.to).toBe('core');
  });

  it('allows custom from/to', () => {
    const msg = createWireRequest({
      method: 'session.prompt',
      sessionId: 'ses_abc',
      from: 'main',
      to: 'sub:agent_1',
    });
    expect(msg.from).toBe('main');
    expect(msg.to).toBe('sub:agent_1');
  });

  it('includes data when provided', () => {
    const msg = createWireRequest({
      method: 'session.prompt',
      sessionId: 'ses_abc',
      data: { input: 'hello world' },
    });
    expect(msg.data).toEqual({ input: 'hello world' });
  });
});

describe('createWireResponse', () => {
  it('generates an id with res_ prefix', () => {
    const msg = createWireResponse({
      requestId: 'req_001',
      sessionId: 'ses_abc',
    });
    expect(msg.id).toMatch(/^res_/);
  });

  it('sets type to response and includes request_id', () => {
    const msg = createWireResponse({
      requestId: 'req_001',
      sessionId: 'ses_abc',
      data: { ok: true },
    });
    expect(msg.type).toBe('response');
    expect(msg.request_id).toBe('req_001');
  });

  it('includes error when provided', () => {
    const msg = createWireResponse({
      requestId: 'req_002',
      sessionId: 'ses_abc',
      error: { code: -32600, message: 'Bad request' },
    });
    expect(msg.error?.code).toBe(-32600);
    expect(msg.data).toBeUndefined();
  });
});

describe('createWireEvent', () => {
  it('generates an id with evt_ prefix', () => {
    const msg = createWireEvent({
      method: 'turn.begin',
      sessionId: 'ses_abc',
      seq: 1,
    });
    expect(msg.id).toMatch(/^evt_/);
  });

  it('sets type to event with seq', () => {
    const msg = createWireEvent({
      method: 'turn.end',
      sessionId: 'ses_abc',
      seq: 42,
      data: { turn_id: 'turn_1', reason: 'done', success: true },
    });
    expect(msg.type).toBe('event');
    expect(msg.seq).toBe(42);
  });

  it('includes turn_id and agent_type when provided', () => {
    const msg = createWireEvent({
      method: 'tool.call',
      sessionId: 'ses_abc',
      seq: 3,
      turnId: 'turn_1',
      agentType: 'sub',
      data: { id: 'tc_1', name: 'Read', args: {} },
    });
    expect(msg.turn_id).toBe('turn_1');
    expect(msg.agent_type).toBe('sub');
  });

  it('defaults from=core, to=client', () => {
    const msg = createWireEvent({
      method: 'content.delta',
      sessionId: 'ses_abc',
      seq: 5,
    });
    expect(msg.from).toBe('core');
    expect(msg.to).toBe('client');
  });
});

// ── Type narrowing helpers (rewrite of test_type_inspection) ────────────

describe('WireMessage type narrowing', () => {
  it('WireRequest has method field', () => {
    const msg: WireRequest = {
      id: 'req_001',
      time: Date.now(),
      session_id: '__process__',
      type: 'request',
      from: 'client',
      to: 'core',
      method: 'initialize',
    };
    expect(msg.type).toBe('request');
    expect(msg.method).toBe('initialize');
  });

  it('WireResponse has request_id field', () => {
    const msg: WireResponse = {
      id: 'res_001',
      time: Date.now(),
      session_id: '__process__',
      type: 'response',
      from: 'core',
      to: 'client',
      request_id: 'req_001',
    };
    expect(msg.type).toBe('response');
    expect(msg.request_id).toBe('req_001');
  });

  it('WireEvent has seq and method fields', () => {
    const msg: WireEvent = {
      id: 'evt_001',
      time: Date.now(),
      session_id: 'ses_abc',
      type: 'event',
      from: 'core',
      to: 'client',
      method: 'turn.begin',
      seq: 1,
    };
    expect(msg.type).toBe('event');
    expect(msg.seq).toBe(1);
  });
});
