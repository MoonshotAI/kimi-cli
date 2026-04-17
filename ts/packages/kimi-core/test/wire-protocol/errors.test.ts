/**
 * Wire protocol error classes unit tests (Phase 10 B).
 *
 * Target — `src/wire-protocol/errors.ts` ≥80% coverage.
 * Covers:
 *   - Error name + instanceof Error relationship
 *   - MalformedWireFrameError retains `cause` chain (ES2022 `Error.cause`)
 *   - Messages round-trip
 *   - Errors are distinct classes (not same constructor)
 */

import { describe, expect, it } from 'vitest';

import {
  InvalidWireEnvelopeError,
  MalformedWireFrameError,
} from '../../src/wire-protocol/index.js';

describe('InvalidWireEnvelopeError', () => {
  it('has name set to InvalidWireEnvelopeError', () => {
    const err = new InvalidWireEnvelopeError('oops');
    expect(err.name).toBe('InvalidWireEnvelopeError');
  });

  it('is an instance of Error', () => {
    const err = new InvalidWireEnvelopeError('oops');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(InvalidWireEnvelopeError);
  });

  it('carries the message verbatim', () => {
    const err = new InvalidWireEnvelopeError('missing request_id');
    expect(err.message).toBe('missing request_id');
  });

  it('is distinguishable from MalformedWireFrameError', () => {
    const err = new InvalidWireEnvelopeError('x');
    expect(err).not.toBeInstanceOf(MalformedWireFrameError);
  });
});

describe('MalformedWireFrameError', () => {
  it('has name set to MalformedWireFrameError', () => {
    const err = new MalformedWireFrameError('bad JSON');
    expect(err.name).toBe('MalformedWireFrameError');
  });

  it('is an instance of Error', () => {
    const err = new MalformedWireFrameError('bad JSON');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MalformedWireFrameError);
  });

  it('preserves the provided cause', () => {
    const inner = new SyntaxError('Unexpected token');
    const err = new MalformedWireFrameError('wrapped', { cause: inner });
    expect(err.cause).toBe(inner);
  });

  it('omits cause when none provided', () => {
    const err = new MalformedWireFrameError('standalone');
    expect(err.cause).toBeUndefined();
  });

  it('preserves cause chain across nested wrapping', () => {
    const root = new Error('root cause');
    const mid = new MalformedWireFrameError('mid', { cause: root });
    const outer = new MalformedWireFrameError('outer', { cause: mid });
    expect(outer.cause).toBe(mid);
    expect((outer.cause as MalformedWireFrameError).cause).toBe(root);
  });

  it('is distinguishable from InvalidWireEnvelopeError', () => {
    const err = new MalformedWireFrameError('x');
    expect(err).not.toBeInstanceOf(InvalidWireEnvelopeError);
  });
});
