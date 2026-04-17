/**
 * Wire message factory unit tests (Phase 10 B).
 *
 * Target — `src/wire-protocol/message-factory.ts` ≥80% coverage.
 * Covers:
 *   - ID prefix discipline (req_ / res_ / evt_) and uniqueness
 *   - Default from / to fallbacks (client ↔ core)
 *   - data undefined → key absent from envelope
 *   - error mutually exclusive with data on response
 *   - seq non-negative integer on event
 *   - turn_id / agent_type optional passthrough on event
 *   - All factory outputs pass WireMessageSchema
 */

import { describe, expect, it } from 'vitest';

import {
  createWireEvent,
  createWireRequest,
  createWireResponse,
  WireMessageSchema,
} from '../../src/wire-protocol/index.js';

describe('createWireRequest — envelope contract', () => {
  it('generates distinct req_-prefixed ids', () => {
    const a = createWireRequest({ method: 'initialize', sessionId: '__process__' });
    const b = createWireRequest({ method: 'initialize', sessionId: '__process__' });
    expect(a.id).toMatch(/^req_/);
    expect(b.id).toMatch(/^req_/);
    expect(a.id).not.toBe(b.id);
  });

  it('defaults from=client, to=core', () => {
    const msg = createWireRequest({ method: 'shutdown', sessionId: '__process__' });
    expect(msg.from).toBe('client');
    expect(msg.to).toBe('core');
  });

  it('allows custom from / to (e.g. reverse RPC core→client)', () => {
    const msg = createWireRequest({
      method: 'approval.request',
      sessionId: 'ses_1',
      from: 'core',
      to: 'client',
    });
    expect(msg.from).toBe('core');
    expect(msg.to).toBe('client');
  });

  it('omits data when not provided', () => {
    const msg = createWireRequest({ method: 'shutdown', sessionId: '__process__' });
    expect('data' in msg).toBe(false);
  });

  it('includes data when provided', () => {
    const msg = createWireRequest({
      method: 'session.prompt',
      sessionId: 'ses_1',
      data: { input: 'hi' },
    });
    expect(msg.data).toEqual({ input: 'hi' });
  });

  it('passes WireMessageSchema validation', () => {
    const msg = createWireRequest({ method: 'initialize', sessionId: '__process__' });
    const result = WireMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('stamps a positive integer time', () => {
    const before = Date.now();
    const msg = createWireRequest({ method: 'initialize', sessionId: '__process__' });
    const after = Date.now();
    expect(Number.isInteger(msg.time)).toBe(true);
    expect(msg.time).toBeGreaterThan(0);
    expect(msg.time).toBeGreaterThanOrEqual(before);
    expect(msg.time).toBeLessThanOrEqual(after);
  });
});

describe('createWireResponse — envelope contract', () => {
  it('generates distinct res_-prefixed ids', () => {
    const a = createWireResponse({ requestId: 'req_1', sessionId: 'ses_1' });
    const b = createWireResponse({ requestId: 'req_1', sessionId: 'ses_1' });
    expect(a.id).toMatch(/^res_/);
    expect(b.id).toMatch(/^res_/);
    expect(a.id).not.toBe(b.id);
  });

  it('defaults from=core, to=client (reverse direction of request)', () => {
    const msg = createWireResponse({ requestId: 'req_1', sessionId: 'ses_1' });
    expect(msg.from).toBe('core');
    expect(msg.to).toBe('client');
  });

  it('copies requestId into request_id', () => {
    const msg = createWireResponse({ requestId: 'req_abc', sessionId: 'ses_1' });
    expect(msg.request_id).toBe('req_abc');
  });

  it('data and error are mutually exclusive — error-only response omits data', () => {
    const msg = createWireResponse({
      requestId: 'req_1',
      sessionId: 'ses_1',
      error: { code: -32600, message: 'bad' },
    });
    expect(msg.error).toEqual({ code: -32600, message: 'bad' });
    expect('data' in msg).toBe(false);
  });

  it('data-only response omits error', () => {
    const msg = createWireResponse({
      requestId: 'req_1',
      sessionId: 'ses_1',
      data: { ok: true },
    });
    expect(msg.data).toEqual({ ok: true });
    expect('error' in msg).toBe(false);
  });

  it('passes WireMessageSchema validation', () => {
    const msg = createWireResponse({
      requestId: 'req_1',
      sessionId: 'ses_1',
      data: { ok: true },
    });
    const result = WireMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });
});

describe('createWireEvent — envelope contract', () => {
  it('generates distinct evt_-prefixed ids', () => {
    const a = createWireEvent({ method: 'turn.begin', sessionId: 'ses_1', seq: 0 });
    const b = createWireEvent({ method: 'turn.begin', sessionId: 'ses_1', seq: 1 });
    expect(a.id).toMatch(/^evt_/);
    expect(b.id).toMatch(/^evt_/);
    expect(a.id).not.toBe(b.id);
  });

  it('preserves seq verbatim (including 0)', () => {
    const msg = createWireEvent({ method: 'turn.begin', sessionId: 'ses_1', seq: 0 });
    expect(msg.seq).toBe(0);
  });

  it('rejects — schema — negative seq even though factory does not validate', () => {
    const msg = createWireEvent({ method: 'turn.begin', sessionId: 'ses_1', seq: -1 });
    const result = WireMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it('omits turn_id and agent_type when not provided', () => {
    const msg = createWireEvent({ method: 'content.delta', sessionId: 'ses_1', seq: 1 });
    expect('turn_id' in msg).toBe(false);
    expect('agent_type' in msg).toBe(false);
  });

  it('includes turn_id and agent_type when provided', () => {
    const msg = createWireEvent({
      method: 'tool.call',
      sessionId: 'ses_1',
      seq: 1,
      turnId: 'turn_1',
      agentType: 'sub',
    });
    expect(msg.turn_id).toBe('turn_1');
    expect(msg.agent_type).toBe('sub');
  });

  it('passes WireMessageSchema validation with optional fields', () => {
    const msg = createWireEvent({
      method: 'turn.begin',
      sessionId: 'ses_1',
      seq: 3,
      turnId: 'turn_7',
      agentType: 'independent',
      data: { turn_id: 'turn_7', user_input: 'q', input_kind: 'user' },
    });
    const result = WireMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('defaults from=core, to=client', () => {
    const msg = createWireEvent({ method: 'content.delta', sessionId: 'ses_1', seq: 1 });
    expect(msg.from).toBe('core');
    expect(msg.to).toBe('client');
  });
});

describe('factory — type-level narrowing', () => {
  it('createWireRequest returns type=request', () => {
    const msg = createWireRequest({ method: 'initialize', sessionId: '__process__' });
    expect(msg.type).toBe('request');
  });

  it('createWireResponse returns type=response', () => {
    const msg = createWireResponse({ requestId: 'req_1', sessionId: 'ses_1' });
    expect(msg.type).toBe('response');
  });

  it('createWireEvent returns type=event', () => {
    const msg = createWireEvent({ method: 'turn.begin', sessionId: 'ses_1', seq: 1 });
    expect(msg.type).toBe('event');
  });
});
