/**
 * PlanModeInjectionProvider — Phase 18 Section D.6 tests.
 *
 * Ports Python `kimi_cli/soul/dynamic_injections/plan_mode.py` which
 * emits three reminder variants:
 *   - `reentry`: one-shot after plan mode toggles on with an existing
 *     plan file
 *   - `full`: first time (no previous reminder in history) OR every
 *     5th reminder (the refresh cadence)
 *   - `sparse`: in between full reminders
 *
 * The TS port ships a single variant; Phase 18 D.6 upgrades it to the
 * 3-variant Python parity.
 *
 * Fingerprints used for history-scan dedupe need to be stable across
 * variants (so the dedupe logic can still detect that "a plan-mode
 * reminder is already present"). We pin the three variant fingerprints
 * below.
 *
 * RED until D.6 lands (the current single-variant provider emits the
 * same text every turn).
 */

import { describe, expect, it } from 'vitest';

import {
  PlanModeInjectionProvider,
  type InjectionContext,
} from '../../src/soul-plus/dynamic-injection.js';

/**
 * Phase 18 D.6 — `getVariant` is a `protected` method on
 * `PlanModeInjectionProvider`. Tests reach it via an unknown-cast to a
 * structural type with the method re-declared as optional/public. This
 * matches the access pattern the review spec pinned in R1 L2.3.
 */
type VariantProvider = PlanModeInjectionProvider & {
  getVariant?(ctx: InjectionContext): 'full' | 'sparse' | 'reentry' | null;
};

function asVariantProvider(p: PlanModeInjectionProvider): VariantProvider {
  return p as unknown as VariantProvider;
}

// Utility: build a minimal history message list.
function userReminder(content: string): {
  role: 'user';
  content: readonly { type: 'text'; text: string }[];
  toolCalls: readonly unknown[];
} {
  return {
    role: 'user',
    content: [{ type: 'text', text: `<system-reminder>${content}</system-reminder>` }],
    toolCalls: [],
  };
}

function assistantTurn(
  content = 'assistant text',
): {
  role: 'assistant';
  content: readonly { type: 'text'; text: string }[];
  toolCalls: readonly unknown[];
} {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    toolCalls: [],
  };
}

describe('PlanModeInjectionProvider — 3 variants (D.6)', () => {
  it('returns no injection when plan mode is inactive', () => {
    const provider = asVariantProvider(new PlanModeInjectionProvider());
    const ctx: InjectionContext = { planMode: false, permissionMode: 'default', turnNumber: 1 };
    const out = provider.getInjections(ctx);
    expect(out === undefined || (Array.isArray(out) && out.length === 0)).toBe(true);
  });

  it('variant = "reentry" on the first turn after plan mode toggles on', () => {
    const provider = asVariantProvider(new PlanModeInjectionProvider());
    // No prior plan-mode reminder in history; the provider is told that a
    // pending-activation flag was consumed this turn. D.6 exposes a
    // `notePlanActivation()` (or similar) to mark this transition.
    const notePlanActivation = (provider as unknown as { notePlanActivation?: () => void })
      .notePlanActivation;
    if (typeof notePlanActivation === 'function') notePlanActivation();

    const ctx: InjectionContext = {
      planMode: true,
      permissionMode: 'default',
      turnNumber: 1,
      history: [],
    };
    const variant = provider.getVariant?.(ctx);
    expect(variant).toBe('reentry');
  });

  it('variant = "full" the first time (no previous reminder in history)', () => {
    const provider = asVariantProvider(new PlanModeInjectionProvider());
    const ctx: InjectionContext = {
      planMode: true,
      permissionMode: 'default',
      turnNumber: 2,
      history: [],
    };
    const variant = provider.getVariant?.(ctx);
    expect(variant).toBe('full');
  });

  it('variant = "sparse" when the last full reminder is within 5 assistant turns', () => {
    const provider = asVariantProvider(new PlanModeInjectionProvider());
    const history = [
      userReminder('Plan mode is active. You MUST NOT make any edits'),
      assistantTurn('reply 1'),
      assistantTurn('reply 2'),
    ];
    const ctx: InjectionContext = {
      planMode: true,
      permissionMode: 'default',
      turnNumber: 3,
      history,
    };
    const variant = provider.getVariant?.(ctx);
    expect(variant).toBe('sparse');
  });

  it('variant = "full" when at least 5 assistant turns have passed since last full', () => {
    const provider = asVariantProvider(new PlanModeInjectionProvider());
    const history = [
      userReminder('Plan mode is active. You MUST NOT make any edits'),
      assistantTurn(),
      assistantTurn(),
      assistantTurn(),
      assistantTurn(),
      assistantTurn(),
    ];
    const ctx: InjectionContext = {
      planMode: true,
      permissionMode: 'default',
      turnNumber: 6,
      history,
    };
    const variant = provider.getVariant?.(ctx);
    expect(variant).toBe('full');
  });
});

describe('PlanModeInjectionProvider — emitted text fingerprints', () => {
  // These fingerprints are stable substrings of the three Python reminder
  // variants. Pinning them makes sure dedupe logic in v2 matches Python
  // history scans.

  function collectText(
    provider: PlanModeInjectionProvider,
    ctx: InjectionContext,
  ): string {
    const maybe = provider.getInjections(ctx);
    if (!Array.isArray(maybe)) return '';
    return maybe.map((i) => i.content).join('\n');
  }

  it('full variant text contains "Plan mode is active" and workflow preamble', () => {
    const provider = new PlanModeInjectionProvider();
    const ctx: InjectionContext = {
      planMode: true,
      permissionMode: 'default',
      turnNumber: 1,
      history: [],
    };
    const text = collectText(provider, ctx);
    // Python `_full_reminder`
    expect(text).toContain('Plan mode is active');
    expect(text.toLowerCase()).toMatch(/workflow|understand|design/);
  });

  it('sparse variant text contains "still active" (Python `_sparse_reminder` prefix)', () => {
    const provider = new PlanModeInjectionProvider();
    // Prime with a prior reminder so the next call emits sparse.
    const history = [
      userReminder('Plan mode is active. You MUST NOT make any edits'),
      assistantTurn(),
      assistantTurn(),
    ];
    const ctx: InjectionContext = {
      planMode: true,
      permissionMode: 'default',
      turnNumber: 2,
      history,
    };
    const text = collectText(provider, ctx);
    expect(text.toLowerCase()).toContain('still active');
  });

  it('reentry variant text contains "Re-entering Plan Mode"', () => {
    const provider = new PlanModeInjectionProvider();
    const notePlanActivation = (provider as unknown as { notePlanActivation?: () => void })
      .notePlanActivation;
    if (typeof notePlanActivation === 'function') notePlanActivation();
    const ctx: InjectionContext = {
      planMode: true,
      permissionMode: 'default',
      turnNumber: 1,
      history: [],
    };
    const text = [
      ...((provider.getInjections(ctx) as Array<{ content: string }>) ?? []),
    ]
      .map((i) => i.content)
      .join('\n');
    expect(text.toLowerCase()).toContain('re-entering plan mode');
  });
});
