/**
 * Phase 2 (Slice 2) — `Runtime` interface must collapse to exactly one
 * field: `kosong`. The three SoulPlus-owned capabilities
 * (`compactionProvider` / `lifecycle` / `journal`) get pushed down into
 * `TurnManagerDeps` and disappear from the Soul-visible Runtime surface.
 *
 * This file is a **type-level** regression test; all the load-bearing
 * assertions (`satisfies Runtime` + `@ts-expect-error`) live inside a
 * never-called function body so they are checked at compile time but
 * never executed at runtime (no `ReferenceError` on null-casted type
 * variables). Vitest still runs the file for its own purposes so we
 * keep one trivial runtime assertion to get a describe/it green tick.
 *
 * Current (pre-Phase-2) behaviour:
 *   - The `{kosong} satisfies Runtime` line DOES NOT compile today because
 *     the current 4-field Runtime requires `compactionProvider` / `lifecycle`
 *     / `journal`. This is the expected failure state — vitest's transform
 *     step will surface the TS error through `pnpm tsc --noEmit`.
 *   - The `@ts-expect-error` before the 2-field `satisfies` attempt stays
 *     valid through both eras (today: missing fields; post-Phase-2: excess
 *     properties — both produce a `satisfies` error).
 *
 * Post-Phase-2 behaviour:
 *   - `{kosong} satisfies Runtime` compiles cleanly.
 *   - `{kosong, compactionProvider} satisfies Runtime` triggers a TS
 *     excess-property error; `@ts-expect-error` absorbs it.
 */

import { describe, expect, it } from 'vitest';

import type {
  CompactionProvider,
  KosongAdapter,
  Runtime,
} from '../../src/soul/runtime.js';

// ── Type-level assertions (never executed) ────────────────────────────

// The body of this function runs through TypeScript's compile step but is
// never called at runtime. That isolates the `satisfies` check (value-
// level syntax required by TS 4.9+) from any runtime cost and avoids the
// `declare const` / `ReferenceError` trap.
function _runtimeShapeTypeCheck(
  fakeKosong: KosongAdapter,
  fakeCompactionProvider: CompactionProvider,
): void {
  // Positive assertion: Runtime is exactly `{kosong}`.
  //   Pre-Phase-2: fails (missing compactionProvider/lifecycle/journal).
  //   Post-Phase-2: compiles cleanly.
  const _singleFieldRuntime = { kosong: fakeKosong } satisfies Runtime;
  void _singleFieldRuntime;

  // Negative assertion: extra fields must be rejected.
  //   Pre-Phase-2: errors (missing lifecycle/journal) — @ts-expect-error absorbs.
  //   Post-Phase-2: errors (excess compactionProvider) — @ts-expect-error absorbs.
  // The `satisfies Runtime` clause must stay on the SAME line as the
  // object literal so `@ts-expect-error` sits immediately above the
  // erroring statement; multi-line variants split the error location
  // and produce a spurious TS2578 "Unused" report.
  // prettier-ignore
  // @ts-expect-error — Runtime must reject any field other than `kosong`
  const _extraFieldRuntime = { kosong: fakeKosong, compactionProvider: fakeCompactionProvider } satisfies Runtime;
  void _extraFieldRuntime;
}
void _runtimeShapeTypeCheck;

describe('Runtime shape — Phase 2 collapse to {kosong}', () => {
  it('is a type-level test — see the compile-time assertions in `_runtimeShapeTypeCheck`', () => {
    // Runtime sanity: the imported types exist and the module loaded.
    // The real contract is enforced by `pnpm tsc --noEmit` at CI time.
    expect(typeof _runtimeShapeTypeCheck).toBe('function');
  });
});
