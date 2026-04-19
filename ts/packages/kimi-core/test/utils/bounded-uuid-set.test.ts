/**
 * BoundedUUIDSet — phase-25 Stage B (TS-native new component).
 *
 * Not a Python port: this utility is newly introduced for the TS
 * rewrite. Design reference is the reference CLI's
 * `bridge/bridgeMessaging.ts:429-461` (bounded de-dupe of forwarded
 * message UUIDs) — a capacity-bound, ring-buffer backed de-dupe set
 * that offers O(1) `add` / `has` while guaranteeing strict FIFO
 * eviction and cross-process memory safety.
 *
 * Core contract pinned here:
 *   - O(1) `add` / `has` (backed by Set lookup + ring-buffer slot).
 *   - Strict FIFO eviction (oldest inserted uuid drops when full),
 *     NOT LRU — a re-`add` of an already-known uuid MUST be a
 *     no-op that does not advance the write index. This is the
 *     subtle invariant the sink wrapper will rely on to avoid
 *     prematurely evicting live UUIDs and re-forwarding replays.
 *   - `capacity` must be a positive integer; `0` / negative throw.
 *   - `clear()` resets both the ring and the Set plus the write
 *     index, allowing previously evicted uuids to be re-added.
 *   - `size` is a getter; accessing it does not mutate state.
 *
 * FAILS until `src/utils/bounded-uuid-set.ts` is implemented.
 */

import { describe, expect, it } from 'vitest';

// Intentionally unresolved until Stage B implementation lands.
// eslint-disable-next-line import/no-unresolved
import { BoundedUUIDSet } from '../../src/utils/bounded-uuid-set.js';

describe('BoundedUUIDSet — construction (phase-25 Stage B)', () => {
  it('constructs with a positive capacity and reports size 0 before any add', () => {
    const set = new BoundedUUIDSet(4);
    expect(set.size).toBe(0);
  });

  it('throws when capacity is 0', () => {
    expect(() => new BoundedUUIDSet(0)).toThrow(
      'BoundedUUIDSet: capacity must be > 0',
    );
  });

  it('throws when capacity is negative', () => {
    // Same error message as the 0-case so callers can recognise the
    // invariant violation regardless of how they mis-sized it.
    expect(() => new BoundedUUIDSet(-1)).toThrow(
      'BoundedUUIDSet: capacity must be > 0',
    );
  });
});

describe('BoundedUUIDSet — basic add / has (phase-25 Stage B)', () => {
  it('reports has=false for a uuid that has never been added', () => {
    const set = new BoundedUUIDSet(8);
    expect(set.has('uuid-never-seen')).toBe(false);
  });

  it('reports has=true for a uuid immediately after add', () => {
    const set = new BoundedUUIDSet(8);
    set.add('uuid-a');
    expect(set.has('uuid-a')).toBe(true);
  });

  it('grows size by 1 for each distinct add while under capacity', () => {
    const set = new BoundedUUIDSet(8);
    set.add('uuid-a');
    expect(set.size).toBe(1);
    set.add('uuid-b');
    expect(set.size).toBe(2);
    set.add('uuid-c');
    expect(set.size).toBe(3);
  });
});

describe('BoundedUUIDSet — idempotent add (phase-25 Stage B)', () => {
  it('does not grow size when the same uuid is added twice', () => {
    const set = new BoundedUUIDSet(8);
    set.add('uuid-a');
    set.add('uuid-a');
    expect(set.size).toBe(1);
    expect(set.has('uuid-a')).toBe(true);
  });

  it('keeps has=true across many repeat adds of the same uuid', () => {
    const set = new BoundedUUIDSet(8);
    for (let i = 0; i < 20; i += 1) {
      set.add('uuid-steady');
    }
    expect(set.size).toBe(1);
    expect(set.has('uuid-steady')).toBe(true);
  });
});

describe('BoundedUUIDSet — FIFO eviction (phase-25 Stage B)', () => {
  it('evicts the oldest uuid when a new add overflows capacity', () => {
    const set = new BoundedUUIDSet(3);
    set.add('A');
    set.add('B');
    set.add('C');
    set.add('D');

    expect(set.has('A')).toBe(false);
    expect(set.has('B')).toBe(true);
    expect(set.has('C')).toBe(true);
    expect(set.has('D')).toBe(true);
    expect(set.size).toBe(3);
  });

  it('continues FIFO eviction across successive overflows', () => {
    const set = new BoundedUUIDSet(3);
    set.add('A');
    set.add('B');
    set.add('C');
    set.add('D'); // evicts A
    set.add('E'); // evicts B

    expect(set.has('A')).toBe(false);
    expect(set.has('B')).toBe(false);
    expect(set.has('C')).toBe(true);
    expect(set.has('D')).toBe(true);
    expect(set.has('E')).toBe(true);
    expect(set.size).toBe(3);
  });

  it('holds size steady at capacity once the ring is full', () => {
    const set = new BoundedUUIDSet(3);
    for (let i = 0; i < 50; i += 1) {
      set.add(`uuid-${i}`);
      expect(set.size).toBeLessThanOrEqual(3);
    }
    expect(set.size).toBe(3);
  });

  // This is THE critical correctness invariant of the idempotent-add
  // branch: if the implementation accidentally advances the ring's
  // write index on a repeat-add it will evict the wrong (still-live)
  // UUID on the next genuinely-new add, and Stage K's sink wrapper
  // will replay duplicate subagent events to the parent bus.
  it('does not advance the write index when the same uuid is re-added', () => {
    const set = new BoundedUUIDSet(3);
    set.add('A');
    set.add('B');
    set.add('C');
    // Re-add A. A is already known; the ring's write index must stay
    // where it is (pointing at A's slot as the next write target).
    set.add('A');
    // The next *new* uuid must therefore overwrite A — not B.
    set.add('D');

    expect(set.has('A')).toBe(false); // A was overwritten by D
    expect(set.has('B')).toBe(true);
    expect(set.has('C')).toBe(true);
    expect(set.has('D')).toBe(true);
    expect(set.size).toBe(3);
  });
});

describe('BoundedUUIDSet — wrap-around stress (phase-25 Stage B)', () => {
  it('retains only the last `capacity` uuids after 10× capacity inserts', () => {
    const capacity = 100;
    const set = new BoundedUUIDSet(capacity);
    const total = 1000;

    for (let i = 0; i < total; i += 1) {
      set.add(`uuid-${i}`);
    }

    // First 900 must all be evicted.
    for (let i = 0; i < total - capacity; i += 1) {
      expect(set.has(`uuid-${i}`)).toBe(false);
    }
    // Last 100 must all be present.
    for (let i = total - capacity; i < total; i += 1) {
      expect(set.has(`uuid-${i}`)).toBe(true);
    }
    expect(set.size).toBe(capacity);
  });
});

describe('BoundedUUIDSet — clear (phase-25 Stage B)', () => {
  it('drops all uuids and resets size to 0', () => {
    const set = new BoundedUUIDSet(4);
    set.add('A');
    set.add('B');
    set.clear();

    expect(set.size).toBe(0);
    expect(set.has('A')).toBe(false);
    expect(set.has('B')).toBe(false);
  });

  it('accepts fresh adds after clear with normal FIFO semantics', () => {
    const set = new BoundedUUIDSet(2);
    set.add('A');
    set.add('B');
    set.clear();

    set.add('X');
    set.add('Y');
    set.add('Z'); // evicts X under capacity=2

    expect(set.has('X')).toBe(false);
    expect(set.has('Y')).toBe(true);
    expect(set.has('Z')).toBe(true);
    expect(set.size).toBe(2);
  });

  it('re-admits a previously-evicted uuid after clear (no history bleed-through)', () => {
    const set = new BoundedUUIDSet(2);
    set.add('A');
    set.add('B');
    set.clear();

    set.add('A'); // would have been historically present; clear must forget it
    expect(set.has('A')).toBe(true);
    expect(set.size).toBe(1);
  });
});

describe('BoundedUUIDSet — capacity=1 boundary (phase-25 Stage B)', () => {
  it('holds exactly one uuid and evicts on every new add', () => {
    const set = new BoundedUUIDSet(1);
    set.add('A');
    expect(set.has('A')).toBe(true);
    expect(set.size).toBe(1);

    set.add('B');
    expect(set.has('A')).toBe(false);
    expect(set.has('B')).toBe(true);
    expect(set.size).toBe(1);
  });

  it('treats repeat add as a no-op at capacity=1', () => {
    const set = new BoundedUUIDSet(1);
    set.add('B');
    set.add('B');
    expect(set.has('B')).toBe(true);
    expect(set.size).toBe(1);
  });

  it('lets a new uuid replace the current one at capacity=1', () => {
    const set = new BoundedUUIDSet(1);
    set.add('B');
    set.add('A');
    expect(set.has('A')).toBe(true);
    expect(set.has('B')).toBe(false);
    expect(set.size).toBe(1);
  });
});

describe('BoundedUUIDSet — return types / side-effect purity (phase-25 Stage B)', () => {
  it('returns undefined from add', () => {
    const set = new BoundedUUIDSet(4);
    const ret = set.add('A');
    expect(ret).toBeUndefined();
  });

  it('returns undefined from clear', () => {
    const set = new BoundedUUIDSet(4);
    set.add('A');
    const ret = set.clear();
    expect(ret).toBeUndefined();
  });

  it('exposes size as a getter that does not mutate state when read', () => {
    const set = new BoundedUUIDSet(4);
    set.add('A');
    set.add('B');

    // Reading size repeatedly must be inert.
    void set.size;
    void set.size;
    void set.size;

    expect(set.size).toBe(2);
    expect(set.has('A')).toBe(true);
    expect(set.has('B')).toBe(true);
  });
});
