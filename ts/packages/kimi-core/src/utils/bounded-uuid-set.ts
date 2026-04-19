/**
 * BoundedUUIDSet — phase-25 Stage B (TS-native new component).
 *
 * Not a Python port: this utility is newly introduced for the TS rewrite,
 * modelled on the reference CLI's `bridge/bridgeMessaging.ts:429-461` —
 * a capacity-bound, ring-buffer backed de-dupe set that offers O(1)
 * `add` / `has` while guaranteeing strict FIFO eviction and cross-process
 * memory safety.
 *
 * Contract (load-bearing for Stage K's sink wrapper):
 *   - O(1) `add` / `has` via a `Set` lookup plus a ring-buffer slot.
 *   - Strict FIFO eviction (oldest inserted uuid drops once full), NOT
 *     LRU — a re-`add` of an already-known uuid is a no-op and MUST NOT
 *     advance the write index, so live UUIDs are never prematurely
 *     evicted by repeat inserts.
 *   - `capacity` must be > 0; `0` or negative throw. Non-integer /
 *     `NaN` / `Infinity` inputs are not guarded here — callers are
 *     trusted internal code that configures capacity from constants or
 *     typed config (phase-25 decision D-UUID-IMPL pins 2000 at the
 *     call site).
 *   - `clear()` resets both the ring and the Set plus the write index,
 *     allowing previously evicted uuids to be re-added cleanly.
 *     O(capacity) — the ring is `fill`-ed to release slot references.
 *   - Not thread-safe — relies on the Node.js single-threaded event loop;
 *     `add` / `has` / `clear` must not be interleaved from workers.
 *   - Memory-only, no persistence — the set resets on process restart.
 *
 * Design decision D-UUID-IMPL pins the default capacity to 2000 for the
 * eventual Stage K caller; this class itself takes `capacity` as a
 * required parameter and does not bake in that default.
 */

export class BoundedUUIDSet {
  private readonly capacity: number;
  private readonly ring: (string | undefined)[];
  private readonly set = new Set<string>();
  private writeIdx = 0;

  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new Error('BoundedUUIDSet: capacity must be > 0');
    }
    this.capacity = capacity;
    this.ring = Array.from<string | undefined>({ length: capacity });
  }

  add(uuid: string): void {
    // Idempotent: re-adding a live uuid must not advance the write
    // index, otherwise the next genuine add would evict the wrong slot.
    if (this.set.has(uuid)) return;
    const evicted = this.ring[this.writeIdx];
    if (evicted !== undefined) this.set.delete(evicted);
    this.ring[this.writeIdx] = uuid;
    this.set.add(uuid);
    this.writeIdx = (this.writeIdx + 1) % this.capacity;
  }

  has(uuid: string): boolean {
    return this.set.has(uuid);
  }

  clear(): void {
    this.set.clear();
    this.ring.fill(undefined);
    this.writeIdx = 0;
  }

  get size(): number {
    return this.set.size;
  }
}
