/**
 * Phase 2 (Slice 2) — `resetToSummary` visibility migration.
 *
 * The method moves from the narrow (Soul-visible) `SoulContextState`
 * interface to the wide (SoulPlus-visible) `FullContextState` interface.
 *
 *   Before Phase 2 (today):
 *     - `SoulContextState.resetToSummary(...)` — compiles
 *     - `FullContextState.resetToSummary(...)` — compiles (inherited)
 *
 *   After Phase 2:
 *     - `SoulContextState.resetToSummary(...)` — TS error (the narrow
 *       interface no longer exposes it; Soul must not have reset power)
 *     - `FullContextState.resetToSummary(...)` — still compiles (the
 *       method is declared directly on the wide interface, or still
 *       inherited from a different shared base)
 *
 * This file is a **type-level** regression test. The `@ts-expect-error`
 * directive on the Soul-view call is the load-bearing assertion:
 *
 *   - Today: the Soul-view call compiles, so `@ts-expect-error` has
 *     "no error to suppress" and itself becomes a TS error — i.e. the
 *     test file fails to compile **today**. This is the expected failure
 *     state (the test drives the migration).
 *   - After Phase 2: the Soul-view call errors, `@ts-expect-error`
 *     swallows it, and the file compiles green.
 *
 * The calls live inside a never-invoked function so TypeScript compiles
 * them but the runtime never evaluates a property access on a
 * null-casted value.
 */

import { describe, expect, it } from 'vitest';

import type {
  FullContextState,
  SoulContextState,
  SummaryMessage,
} from '../../src/storage/context-state.js';

// ── Type-level assertions (never executed) ───────────────────────────

function _resetToSummaryVisibilityTypeCheck(
  sc: SoulContextState,
  fc: FullContextState,
  summary: SummaryMessage,
): void {
  // Negative: Soul view must NOT expose resetToSummary after Phase 2.
  // @ts-expect-error — Phase 2: `resetToSummary` migrates off of SoulContextState
  void sc.resetToSummary(summary);

  // Positive: Full view must expose resetToSummary (today via inheritance,
  // post-Phase-2 declared directly).
  void fc.resetToSummary(summary);
}
void _resetToSummaryVisibilityTypeCheck;

describe('resetToSummary visibility — Phase 2 Soul → Full migration', () => {
  it('is a type-level test — see compile-time assertions in `_resetToSummaryVisibilityTypeCheck`', () => {
    expect(typeof _resetToSummaryVisibilityTypeCheck).toBe('function');
  });
});
