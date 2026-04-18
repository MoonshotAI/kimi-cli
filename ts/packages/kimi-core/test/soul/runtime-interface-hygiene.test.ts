/**
 * Slice 20-B R-3 — Runtime interface hygiene (铁律 6 / §5.0 rule 3).
 *
 * `src/soul/runtime.ts` currently still **declares** three SoulPlus-only
 * interfaces (`CompactionProvider` / `LifecycleGate` / `JournalCapability`)
 * that were removed from the Runtime aggregate by 决策 #93 in Phase 2.
 * They linger as exported types only so `TurnManagerDeps` / tests can
 * reach them — but their living *inside* Soul's only public module
 * breaches 铁律 3 (Soul import whitelist) and confuses readers about who
 * owns compaction / lifecycle / journaling.
 *
 * Phase 20 §C.1 moves the declarations down into the SoulPlus files
 * that own those capabilities and keeps `soul/runtime.ts` as a slim
 * re-export (minimal blast radius — existing 21 src + 38 test imports
 * stay valid).
 *
 * Red bars below:
 *   1. Sentinel — `soul/runtime.ts` source text no longer contains the
 *      three interface **declarations**. Re-export lines are allowed.
 *   2. Structural — `Runtime` still has exactly one key (`kosong`).
 *   3. Provenance — each of the three interfaces is importable from its
 *      new SoulPlus home (`soul-plus/compaction-provider.ts` etc.) AND
 *      from the legacy `soul/index.js` barrel (backward compat).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  CompactionProvider as CompactionProviderFromSoul,
  JournalCapability as JournalCapabilityFromSoul,
  KosongAdapter,
  LifecycleGate as LifecycleGateFromSoul,
  Runtime,
} from '../../src/soul/runtime.js';

// New homes — these imports are load-bearing. If any of the three
// interfaces fails to resolve at its new SoulPlus location, this file
// fails to compile — that's the red-bar driver for the move.
import type { CompactionProvider as CompactionProviderFromSoulPlus } from '../../src/soul-plus/compaction-provider.js';
import type { JournalCapability as JournalCapabilityFromSoulPlus } from '../../src/soul-plus/journal-capability.js';
import type { LifecycleGate as LifecycleGateFromSoulPlus } from '../../src/soul-plus/soul-lifecycle-gate.js';

const RUNTIME_PATH = resolve(
  import.meta.dirname,
  '../../src/soul/runtime.ts',
);

// ── 1. Sentinel: runtime.ts no longer DECLARES the 3 interfaces ─────────

describe('Phase 20 R-3 — soul/runtime.ts sentinel', () => {
  it('does not declare the CompactionProvider interface body', () => {
    const src = readFileSync(RUNTIME_PATH, 'utf8');
    // Declaration is the only forbidden form. Re-exports
    // (`export type { CompactionProvider } from '...';`) stay allowed so
    // `21 + 38` existing import paths keep resolving — that's the whole
    // point of the minimal-blast-radius strategy.
    expect(src).not.toMatch(/export\s+interface\s+CompactionProvider\b/);
  });

  it('does not declare the LifecycleGate interface body', () => {
    const src = readFileSync(RUNTIME_PATH, 'utf8');
    expect(src).not.toMatch(/export\s+interface\s+LifecycleGate\b/);
  });

  it('does not declare the JournalCapability interface body', () => {
    const src = readFileSync(RUNTIME_PATH, 'utf8');
    expect(src).not.toMatch(/export\s+interface\s+JournalCapability\b/);
  });
});

// ── 2. Structural: Runtime still collapses to {kosong} ──────────────────

/** Narrow stand-in for the real `KosongAdapter` — only the shape matters. */
function makeFakeKosong(): KosongAdapter {
  return { chat: async () => { throw new Error('test-only'); } } as KosongAdapter;
}

describe('Phase 20 R-3 — Runtime stays single-field', () => {
  it('accepts { kosong } and rejects every other key', () => {
    // Positive — compiles iff Runtime === { kosong }.
    const rt = { kosong: makeFakeKosong() } satisfies Runtime;
    expect(Object.keys(rt)).toEqual(['kosong']);

    // Negative — adding any SoulPlus capability must trigger a
    // TS excess-property error. `@ts-expect-error` absorbs the error;
    // if the 3 interfaces crept back into Runtime, the excess check
    // would pass and the `@ts-expect-error` would flip to "unused".
    // prettier-ignore
    // @ts-expect-error — Runtime must reject anything except `kosong`
    const _extra = { kosong: makeFakeKosong(), journal: {} as JournalCapabilityFromSoul } satisfies Runtime;
    void _extra;
  });
});

// ── 3. Provenance: imports work from both old and new locations ─────────

describe('Phase 20 R-3 — interface provenance', () => {
  it('CompactionProvider is structurally the same type from both import paths', () => {
    // Compile-time: swap between the two paths must be a no-op.
    function _identity(p: CompactionProviderFromSoulPlus): CompactionProviderFromSoul {
      return p;
    }
    function _identityReverse(p: CompactionProviderFromSoul): CompactionProviderFromSoulPlus {
      return p;
    }
    void _identity;
    void _identityReverse;
    // Runtime: trivial — the assertion is compile-time.
    expect(true).toBe(true);
  });

  it('JournalCapability is structurally the same type from both import paths', () => {
    function _identity(p: JournalCapabilityFromSoulPlus): JournalCapabilityFromSoul {
      return p;
    }
    function _identityReverse(p: JournalCapabilityFromSoul): JournalCapabilityFromSoulPlus {
      return p;
    }
    void _identity;
    void _identityReverse;
    expect(true).toBe(true);
  });

  it('LifecycleGate is structurally the same type from both import paths', () => {
    function _identity(p: LifecycleGateFromSoulPlus): LifecycleGateFromSoul {
      return p;
    }
    function _identityReverse(p: LifecycleGateFromSoul): LifecycleGateFromSoulPlus {
      return p;
    }
    void _identity;
    void _identityReverse;
    expect(true).toBe(true);
  });
});
