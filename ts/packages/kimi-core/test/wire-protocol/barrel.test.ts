/**
 * Wire protocol barrel completeness test (Phase 10 B).
 *
 * Ensures every export from `src/wire-protocol/index.ts` resolves to a
 * non-undefined value at runtime. Acts as a smoke-guard against accidental
 * dead re-exports or renames drifting out of the barrel.
 */

import { describe, expect, it } from 'vitest';

import * as wire from '../../src/wire-protocol/index.js';

describe('wire-protocol barrel exports', () => {
  it('exposes all runtime values', () => {
    expect(wire.WIRE_PROTOCOL_VERSION).toBe('2.1');
    expect(wire.PROCESS_SESSION_ID).toBe('__process__');
    expect(wire.WireCodec).toBeDefined();
    expect(wire.WireErrorSchema).toBeDefined();
    expect(wire.WireMessageSchema).toBeDefined();
    expect(wire.InvalidWireEnvelopeError).toBeDefined();
    expect(wire.MalformedWireFrameError).toBeDefined();
    expect(wire.createWireRequest).toBeDefined();
    expect(wire.createWireResponse).toBeDefined();
    expect(wire.createWireEvent).toBeDefined();
  });

  it('runtime values are callable / constructable as documented', () => {
    const codec = new wire.WireCodec();
    expect(typeof codec.encode).toBe('function');
    expect(typeof codec.decode).toBe('function');

    const req = wire.createWireRequest({ method: 'initialize', sessionId: '__process__' });
    expect(req.type).toBe('request');

    const res = wire.createWireResponse({ requestId: 'req_1', sessionId: 'ses_1' });
    expect(res.type).toBe('response');

    const evt = wire.createWireEvent({
      method: 'turn.begin',
      sessionId: 'ses_1',
      seq: 0,
    });
    expect(evt.type).toBe('event');

    const err = new wire.InvalidWireEnvelopeError('m');
    expect(err.name).toBe('InvalidWireEnvelopeError');
  });

  it('zod schemas expose safeParse', () => {
    expect(typeof wire.WireMessageSchema.safeParse).toBe('function');
    expect(typeof wire.WireErrorSchema.safeParse).toBe('function');
  });

  it('barrel matches the canonical export list', () => {
    const exported = new Set(Object.keys(wire));
    const expected = [
      'WIRE_PROTOCOL_VERSION',
      'PROCESS_SESSION_ID',
      'WireCodec',
      'WireErrorSchema',
      'WireMessageSchema',
      'InvalidWireEnvelopeError',
      'MalformedWireFrameError',
      'createWireRequest',
      'createWireResponse',
      'createWireEvent',
    ];
    // arrayContaining diffs surface every missing name at once instead
    // of stopping at the first hit.
    expect([...exported]).toEqual(expect.arrayContaining(expected));
  });
});
