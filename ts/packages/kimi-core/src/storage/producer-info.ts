/**
 * Phase 22 — module-level producer identity (see v2 铁律 6).
 *
 * Every wire.jsonl metadata header carries a `producer` field stamped from
 * the current `getProducerInfo()` snapshot. Hosts inject their runtime
 * identity via `setProducerInfo()` at bootstrap; in the absence of such a
 * call `DEFAULT_PRODUCER` (version `'0.0.0-unset'`) is used so that missing
 * host wiring is easy to spot in the field.
 *
 * Kept intentionally orthogonal to the Runtime facade (铁律 6): producer
 * info is a process-global, not a Soul-visible dependency.
 */

import type { WireProducer } from './wire-record.js';

const DEFAULT_PRODUCER: WireProducer = {
  kind: 'typescript',
  name: '@moonshot-ai/core',
  version: '0.0.0-unset',
};

let producerCache: WireProducer = { ...DEFAULT_PRODUCER };

/**
 * Merge-update the process-global producer identity. Typical host bootstrap:
 * `setProducerInfo({ kind: 'typescript', name: '@moonshot-ai/core', version: pkg.version })`.
 */
export function setProducerInfo(info: Partial<WireProducer>): void {
  producerCache = { ...producerCache, ...info };
}

/**
 * Snapshot the current producer identity. Returns a fresh object on each
 * call so downstream mutations can't leak back into the cache.
 */
export function getProducerInfo(): WireProducer {
  // Shallow copy is sufficient because WireProducer fields are all
  // primitives. If the shape ever grows a nested object, switch to a
  // deep clone so callers can't mutate the cached snapshot.
  return { ...producerCache };
}

/** Test-only — reset the cache to DEFAULT_PRODUCER. */
export function _resetProducerInfoForTest(): void {
  producerCache = { ...DEFAULT_PRODUCER };
}
