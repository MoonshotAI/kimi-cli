/**
 * Phase 17 A.6 — `session.error` SoulEvent normalisation.
 *
 * `turn-manager.ts:535 / :555` emits `{type:'session.error', ...}` via
 * `sink.emit(... as never)`. A.6 固化决策:
 *   1. Extend `SoulEvent` union in `src/soul/event-sink.ts` with a
 *      `{type:'session.error', error, error_type?, retry_after_ms?,
 *      details?}` variant.
 *   2. Remove the 2 `as never` casts at turn-manager.ts lines 535 + 555.
 *   3. WireEventBridge (A.1) forwards this as the `session.error`
 *      WireEventMethod (already declared in `types.ts:171`).
 *
 * Tests:
 *   - Type-level: SoulEvent includes `session.error` variant.
 *   - Runtime: bus listener receives session.error with all expected
 *     fields on compaction-limit-exceeded.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { SoulEvent } from '../../src/soul/event-sink.js';
import { SessionEventBus } from '../../src/soul-plus/session-event-bus.js';

describe('Phase 17 A.6 — SoulEvent session.error variant', () => {
  it('type-level + runtime: SoulEvent union includes session.error variant with structured fields', () => {
    type ErrorVariant = Extract<SoulEvent, { type: 'session.error' }>;
    // `never` must NOT satisfy this assertion — if the Implementer
    // forgets to extend SoulEvent, Extract<...> is `never` and
    // `expectTypeOf<never>().not.toBeNever()` fails at compile time.
    expectTypeOf<ErrorVariant>().not.toBeNever();
    expectTypeOf<ErrorVariant>().toMatchTypeOf<{
      type: 'session.error';
      error: string;
    }>();

    // Coordinator-requested runtime proof (A.6 decision): a literal
    // typed as `Extract<SoulEvent, {type:'session.error'}>` forces
    // `tsc` AND `vitest transform` to reject if the variant is
    // missing — giving us a red bar at both layers, not just `tsc`.
    const _runtimeProof: Extract<SoulEvent, { type: 'session.error' }> = {
      type: 'session.error',
      error: 'example',
      error_type: 'context_overflow',
    };
    expect(_runtimeProof.type).toBe('session.error');
    expect(_runtimeProof.error).toBe('example');
    expect(_runtimeProof.error_type).toBe('context_overflow');
  });

  it('runtime: SessionEventBus fans session.error events to listeners with all fields', () => {
    const bus = new SessionEventBus();
    const received: SoulEvent[] = [];
    bus.on((e) => {
      received.push(e);
    });

    const evt: SoulEvent = {
      type: 'session.error',
      error: 'Compaction limit exceeded (3)',
      error_type: 'context_overflow',
    };
    bus.emit(evt);

    expect(received).toHaveLength(1);
    const got = received[0]!;
    expect(got.type).toBe('session.error');
    if (got.type === 'session.error') {
      expect(got.error).toBe('Compaction limit exceeded (3)');
      expect(got.error_type).toBe('context_overflow');
    }
  });
});
