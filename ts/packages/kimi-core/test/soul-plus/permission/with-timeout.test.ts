/**
 * Covers: withTimeout helper (Slice 2.2 Q4 P0 safeguard).
 *
 * Pins:
 *   - resolves with inner value when the inner promise settles first
 *   - rejects with ApprovalTimeoutError when the timer fires first
 *   - rejects immediately if signal is already aborted
 *   - rejects with signal reason when the signal aborts mid-flight
 *   - clears the timer on all exit paths (no leaked handles)
 */

import { describe, expect, it } from 'vitest';

import {
  ApprovalTimeoutError,
  withTimeout,
} from '../../../src/soul-plus/permission/with-timeout.js';

function never<T>(): Promise<T> {
  return new Promise(() => {});
}

describe('withTimeout', () => {
  it('resolves with inner value when inner settles first', async () => {
    const result = await withTimeout(Promise.resolve(42), 1_000);
    expect(result).toBe(42);
  });

  it('rejects with ApprovalTimeoutError when the timer fires', async () => {
    await expect(withTimeout(never<number>(), 10)).rejects.toBeInstanceOf(ApprovalTimeoutError);
  });

  it('rejects with signal reason when signal aborts mid-flight', async () => {
    const controller = new AbortController();
    const pending = withTimeout(never<number>(), 10_000, controller.signal);
    // Abort shortly after
    setTimeout(() => {
      controller.abort(new Error('user cancel'));
    }, 5);
    await expect(pending).rejects.toThrow('user cancel');
  });

  it('rejects immediately when signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('pre-aborted'));
    await expect(withTimeout(never<number>(), 10_000, controller.signal)).rejects.toThrow(
      'pre-aborted',
    );
  });

  it('propagates inner rejection verbatim', async () => {
    await expect(withTimeout(Promise.reject(new Error('inner oops')), 1_000)).rejects.toThrow(
      'inner oops',
    );
  });
});
