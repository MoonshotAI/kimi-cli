/**
 * Slice 5 / 决策 #96 / Overflow L3: ContextOverflowError class shape.
 *
 * Soul-side error type. Phase 5 Implementer adds this class to
 * `src/soul/errors.ts` (or a sibling file) and exports it through
 * `src/soul/index.ts` so both KosongAdapter (throw) and TurnManager
 * (catch) can reference one identity.
 *
 * Pins (v2 §10 / 决策 #96 L3):
 *   - Class exists and is constructible
 *   - `code === 'context_overflow'`
 *   - Optional `usage?: TokenUsage` carried on the instance
 *   - `instanceof ContextOverflowError` narrows correctly
 *   - `name === 'ContextOverflowError'` (so devtools / stack traces show the
 *     dedicated name, not `Error`)
 *
 * Expected to FAIL before Phase 5 Implementer adds the class — see
 * `packages/kimi-core/src/soul/errors.ts` (currently only exports
 * `MaxStepsExceededError`).
 */

import { describe, expect, it } from 'vitest';

import { ContextOverflowError } from '../../src/soul/errors.js';
import type { TokenUsage } from '../../src/soul/types.js';

describe('ContextOverflowError — Slice 5 / 决策 #96 L3', () => {
  it('is a constructible class', () => {
    const err = new ContextOverflowError('overflow detected');
    expect(err).toBeInstanceOf(ContextOverflowError);
    expect(err).toBeInstanceOf(Error);
  });

  it('carries `code === "context_overflow"` as a readable field', () => {
    const err = new ContextOverflowError('overflow detected');
    expect(err.code).toBe('context_overflow');
  });

  it('preserves the message passed to the constructor', () => {
    const err = new ContextOverflowError('input=250K exceeds contextWindow=200K');
    expect(err.message).toBe('input=250K exceeds contextWindow=200K');
  });

  it('exposes `name === "ContextOverflowError"` (not "Error") for stack trace clarity', () => {
    const err = new ContextOverflowError('x');
    expect(err.name).toBe('ContextOverflowError');
  });

  it('optionally carries TokenUsage on the instance', () => {
    const usage: TokenUsage = { input: 250_000, output: 0, cache_read: 120_000 };
    const err = new ContextOverflowError('overflow', usage);
    expect(err.usage).toEqual(usage);
  });

  it('usage field is undefined when not supplied', () => {
    const err = new ContextOverflowError('overflow');
    expect(err.usage).toBeUndefined();
  });

  it('`instanceof ContextOverflowError` narrows from unknown', () => {
    const thrown: unknown = new ContextOverflowError('x');
    if (thrown instanceof ContextOverflowError) {
      // Type-narrow check: `.code` is accessible on the narrowed branch.
      expect(thrown.code).toBe('context_overflow');
      return;
    }
    throw new Error('narrowing failed');
  });
});
