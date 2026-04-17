/**
 * Unit tests for DynamicInjectionManager + built-in providers (Slice 3.6).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DynamicInjectionManager,
  PlanModeInjectionProvider,
  YoloModeInjectionProvider,
  createDefaultDynamicInjectionManager,
  type DynamicInjectionProvider,
  type InjectionContext,
} from '../../src/soul-plus/dynamic-injection.js';
import type { EphemeralInjection } from '../../src/storage/projector.js';

const baseCtx = (overrides: Partial<InjectionContext> = {}): InjectionContext => ({
  planMode: false,
  permissionMode: 'default',
  turnNumber: 1,
  ...overrides,
});

describe('DynamicInjectionManager', () => {
  it('computes injections from registered providers in order', () => {
    const a: DynamicInjectionProvider = {
      id: 'a',
      getInjections: () => [{ kind: 'system_reminder', content: 'first' }],
    };
    const b: DynamicInjectionProvider = {
      id: 'b',
      getInjections: () => [{ kind: 'system_reminder', content: 'second' }],
    };
    const manager = new DynamicInjectionManager({ initialProviders: [a, b] });

    const out = manager.computeInjections(baseCtx());

    expect(out).toEqual([
      { kind: 'system_reminder', content: 'first' },
      { kind: 'system_reminder', content: 'second' },
    ]);
  });

  it('returns an empty list when no provider emits', () => {
    const manager = new DynamicInjectionManager({
      initialProviders: [
        { id: 'quiet', getInjections: () => [] satisfies readonly EphemeralInjection[] },
      ],
    });
    expect(manager.computeInjections(baseCtx())).toEqual([]);
  });

  it('register is idempotent on id — replacing the previous entry', () => {
    const manager = new DynamicInjectionManager();
    manager.register({
      id: 'x',
      getInjections: () => [{ kind: 'system_reminder', content: 'old' }],
    });
    manager.register({
      id: 'x',
      getInjections: () => [{ kind: 'system_reminder', content: 'new' }],
    });

    expect(manager.list()).toHaveLength(1);
    expect(manager.computeInjections(baseCtx())).toEqual([
      { kind: 'system_reminder', content: 'new' },
    ]);
  });

  it('unregister removes the provider by id', () => {
    const manager = new DynamicInjectionManager({
      initialProviders: [
        { id: 'a', getInjections: () => [{ kind: 'system_reminder', content: 'a' }] },
        { id: 'b', getInjections: () => [{ kind: 'system_reminder', content: 'b' }] },
      ],
    });

    manager.unregister('a');
    expect(manager.list()).toHaveLength(1);
    expect(manager.computeInjections(baseCtx())).toEqual([
      { kind: 'system_reminder', content: 'b' },
    ]);
  });

  it('isolates provider errors — other providers still run', () => {
    const onError = vi.fn();
    const manager = new DynamicInjectionManager({
      initialProviders: [
        {
          id: 'boom',
          getInjections: () => {
            throw new Error('kaboom');
          },
        },
        {
          id: 'good',
          getInjections: () => [{ kind: 'system_reminder', content: 'ok' }],
        },
      ],
      onProviderError: onError,
    });

    const out = manager.computeInjections(baseCtx());
    expect(out).toEqual([{ kind: 'system_reminder', content: 'ok' }]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0].id).toBe('boom');
    expect(onError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });
});

describe('PlanModeInjectionProvider', () => {
  it('emits nothing when plan mode is off', () => {
    const provider = new PlanModeInjectionProvider();
    expect(provider.getInjections(baseCtx())).toEqual([]);
  });

  it('emits a system-reminder when plan mode is on', () => {
    const provider = new PlanModeInjectionProvider();
    const out = provider.getInjections(baseCtx({ planMode: true })) as readonly EphemeralInjection[];
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('system_reminder');
    expect(out[0]?.content as string).toContain('Plan mode is active');
  });

  it('re-emits on every turn while plan mode stays active (no throttle)', () => {
    const provider = new PlanModeInjectionProvider();
    const t1 = provider.getInjections(baseCtx({ planMode: true, turnNumber: 1 }));
    const t5 = provider.getInjections(baseCtx({ planMode: true, turnNumber: 5 }));
    expect(t1).toHaveLength(1);
    expect(t5).toHaveLength(1);
  });
});

describe('YoloModeInjectionProvider', () => {
  it('emits nothing outside bypassPermissions', () => {
    const provider = new YoloModeInjectionProvider();
    expect(provider.getInjections(baseCtx({ permissionMode: 'default' }))).toEqual([]);
    expect(provider.getInjections(baseCtx({ permissionMode: 'acceptEdits' }))).toEqual([]);
  });

  it('emits once on entering bypassPermissions, then stays silent', () => {
    const provider = new YoloModeInjectionProvider();
    const first = provider.getInjections(baseCtx({ permissionMode: 'bypassPermissions' })) as readonly EphemeralInjection[];
    expect(first).toHaveLength(1);
    expect(first[0]?.content as string).toContain('yolo');

    const second = provider.getInjections(baseCtx({ permissionMode: 'bypassPermissions' }));
    expect(second).toEqual([]);
  });

  it('resets the one-shot after leaving and re-entering bypass mode', () => {
    const provider = new YoloModeInjectionProvider();
    provider.getInjections(baseCtx({ permissionMode: 'bypassPermissions' }));
    // Leave yolo
    provider.getInjections(baseCtx({ permissionMode: 'default' }));
    // Re-enter — one-shot should fire again
    const third = provider.getInjections(baseCtx({ permissionMode: 'bypassPermissions' }));
    expect(third).toHaveLength(1);
  });
});

describe('createDefaultDynamicInjectionManager', () => {
  it('pre-registers plan + yolo providers', () => {
    const manager = createDefaultDynamicInjectionManager();
    const ids = manager.list().map((p) => p.id);
    expect(ids).toEqual(['plan_mode', 'yolo_mode']);
  });

  it('integration — both providers fire when both conditions active', () => {
    const manager = createDefaultDynamicInjectionManager();
    const out = manager.computeInjections({
      planMode: true,
      permissionMode: 'bypassPermissions',
      turnNumber: 1,
    });
    expect(out).toHaveLength(2);
    expect(out[0]?.content as string).toContain('Plan mode is active');
    expect(out[1]?.content as string).toContain('yolo');
  });
});

// ── Phase 1 Step 7: Dynamic injection durable write + dedup ───────────
//
// Decision #89: DynamicInjection providers write to
// contextState.appendSystemReminder (durable) instead of producing
// ephemeral EphemeralInjection objects. Dedup: if the last
// system_reminder in history is the same plan mode reminder and no new
// user message has appeared since, don't re-inject.
//
// These tests FAIL on the current codebase because:
//   - Providers return ephemeral injections, not durable writes
//   - No dedup logic based on history scanning exists
//   - InjectionContext does not include history

describe('PlanModeInjectionProvider — durable write path (Phase 1 Step 7)', () => {
  it('writes to contextState.appendSystemReminder instead of returning ephemeral injection', () => {
    // Phase 1 contract: PlanModeInjectionProvider.getInjections receives
    // a contextState and calls appendSystemReminder on it, rather than
    // returning EphemeralInjection objects for the caller to stash.
    //
    // New signature: getInjections(ctx, contextState) → void (or Promise<void>)
    // Currently: getInjections(ctx) → readonly EphemeralInjection[]
    const provider = new PlanModeInjectionProvider();

    const appendCalls: string[] = [];
    const fakeContextState = {
      appendSystemReminder: async (data: { content: string }) => {
        appendCalls.push(data.content);
      },
    };

    // Phase 1: provider takes contextState as second argument
    const result = (provider as unknown as {
      getInjections(
        ctx: InjectionContext,
        contextState: { appendSystemReminder(d: { content: string }): Promise<void> },
      ): void;
    }).getInjections(baseCtx({ planMode: true }), fakeContextState);

    // Phase 1: provider writes to contextState, returns void (not an array)
    // FAILS on current code: returns EphemeralInjection[] (truthy array)
    expect(result).toBeUndefined();
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]).toContain('Plan mode is active');
  });

  it('dedup: does NOT re-inject if history already has plan mode reminder with no new user message', () => {
    // Phase 1 contract: if the last system_reminder in history is the
    // plan mode reminder and no user_message has been appended since,
    // the provider skips injection. This prevents duplicate reminders
    // on consecutive turns without user input.
    //
    // Ported from Python plan_mode.py:64-81 (_has_plan_reminder scan).
    //
    // Current code always returns the reminder when planMode is true,
    // with no history scanning. This test verifies the Phase 1 dedup
    // behavior by asserting that getInjections returns empty when a
    // plan mode reminder already exists in history.
    const provider = new PlanModeInjectionProvider();

    // Phase 1: InjectionContext includes history for dedup scanning
    const ctxWithHistory = {
      ...baseCtx({ planMode: true }),
      history: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<system-reminder>\nPlan mode is active. You MUST NOT make any edits.\n</system-reminder>',
            },
          ],
          toolCalls: [],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'I will plan...' }],
          toolCalls: [],
        },
        // No new user message since the reminder
      ],
    };

    // Current API still works (extra ctx fields ignored) — the assertion
    // checks the return value. Current code returns the injection; Phase 1
    // should return empty (deduped).
    const result = provider.getInjections(ctxWithHistory);

    // Phase 1: should return empty because the plan mode reminder is
    // already the most recent system_reminder with no new user message.
    // FAILS on current code: always returns the reminder
    expect(result).toEqual([]);
  });

  it('injects when a new user message appeared after the last plan mode reminder (durable path)', () => {
    // Phase 1: even with dedup, a fresh user message after the last
    // plan mode reminder means we DO inject via contextState.appendSystemReminder.
    const provider = new PlanModeInjectionProvider();

    const appendCalls: string[] = [];
    const fakeContextState = {
      appendSystemReminder: async (data: { content: string }) => {
        appendCalls.push(data.content);
      },
    };

    const ctxWithNewUser = {
      ...baseCtx({ planMode: true }),
      history: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<system-reminder>\nPlan mode is active.\n</system-reminder>',
            },
          ],
          toolCalls: [],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'planning...' }],
          toolCalls: [],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'new user prompt' }],
          toolCalls: [],
        },
      ],
    };

    // Phase 1 durable path: pass contextState as 2nd arg
    const result = (provider as unknown as {
      getInjections(
        ctx: InjectionContext,
        contextState: { appendSystemReminder(d: { content: string }): Promise<void> },
      ): void;
    }).getInjections(ctxWithNewUser, fakeContextState);

    // Phase 1: returns void, writes to contextState
    expect(result).toBeUndefined();
    // Should inject because a new user message appeared after the last reminder
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]).toContain('Plan mode');
  });
});

describe('YoloModeInjectionProvider — durable write path (Phase 1 Step 7)', () => {
  it('writes to contextState.appendSystemReminder instead of returning ephemeral', () => {
    const provider = new YoloModeInjectionProvider();

    const appendCalls: string[] = [];
    const fakeContextState = {
      appendSystemReminder: async (data: { content: string }) => {
        appendCalls.push(data.content);
      },
    };

    const result = (provider as unknown as {
      getInjections(
        ctx: InjectionContext,
        contextState: { appendSystemReminder(d: { content: string }): Promise<void> },
      ): void;
    }).getInjections(baseCtx({ permissionMode: 'bypassPermissions' }), fakeContextState);

    // Phase 1: returns void, writes to contextState
    // FAILS on current code: returns EphemeralInjection[]
    expect(result).toBeUndefined();
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]).toContain('yolo');
  });

  it('dedup: does NOT re-inject if history already has yolo reminder with no new user message', () => {
    // Phase 1: yolo mode provider dedupes against history just like
    // plan mode — if the last system_reminder is a yolo reminder and
    // no new user message since, skip injection.
    //
    // Current code uses an internal `injected` boolean for one-shot
    // semantics but does NOT scan history. This test fires on a FRESH
    // provider instance (no prior injection) so the one-shot hasn't
    // fired yet — current code would inject. Phase 1 should NOT inject
    // because history already has the reminder.
    const provider = new YoloModeInjectionProvider();

    const ctxWithExistingYolo = {
      ...baseCtx({ permissionMode: 'bypassPermissions' }),
      history: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<system-reminder>\nYou are running in non-interactive (yolo) mode.\n</system-reminder>',
            },
          ],
          toolCalls: [],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'proceeding...' }],
          toolCalls: [],
        },
      ],
    };

    const result = provider.getInjections(ctxWithExistingYolo);

    // Phase 1: should return empty — yolo reminder already in history.
    // FAILS on current code: fresh provider instance hasn't fired its
    // one-shot yet, so it returns the yolo reminder.
    expect(result).toEqual([]);
  });
});

// ── Phase 15 A.5 — plan-mode reminder detection contract ────────────
//
// Python test_plan_mode_reminder.py (tests/core/):
//   - test_does_not_match_unrelated_text: the dedup scan must not false-
//     positive on a plain user message that happens to mention "plan mode"
//     (only <system-reminder>-wrapped matches count).
//   - test_detection_stays_in_sync_with_reminder_text: the fingerprint
//     used to detect an existing reminder must stay a substring of what
//     PlanModeInjectionProvider actually emits. If someone renames the
//     reminder copy but not the fingerprint, dedup silently stops working
//     and users get duplicate reminders every turn.

describe('Plan-mode reminder detection (Phase 15 A.5)', () => {
  it('does NOT dedup against a plain user message that merely mentions "plan mode"', () => {
    // A casual user message like "I think plan mode is active would be
    // useful here" must not trip the dedup check — only messages that
    // start with `<system-reminder>` count as reminder evidence.
    const provider = new PlanModeInjectionProvider();
    const ctx = {
      ...baseCtx({ planMode: true }),
      history: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'I think plan mode is active would be useful here.' },
          ],
          toolCalls: [],
        },
      ],
    };
    const out = provider.getInjections(ctx);
    // Reminder must still be emitted — no false-positive dedup.
    expect(Array.isArray(out) ? out.length : 0).toBe(1);
  });

  it('reminder detection fingerprint stays in sync with the emitted reminder text', () => {
    // Step 1: emit a fresh reminder on a blank history.
    const provider = new PlanModeInjectionProvider();
    const first = provider.getInjections(baseCtx({ planMode: true })) as readonly EphemeralInjection[];
    expect(first).toHaveLength(1);
    const emitted = (first[0]?.content as string) ?? '';
    expect(emitted.length).toBeGreaterThan(0);

    // Step 2: fold the exact emitted text back into history as a
    // <system-reminder> — this is how TurnManager actually stashes it.
    const ctxWithEmitted = {
      ...baseCtx({ planMode: true }),
      history: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `<system-reminder>\n${emitted}\n</system-reminder>`,
            },
          ],
          toolCalls: [],
        },
      ],
    };

    // Step 3: dedup MUST fire — the fingerprint and the emission are in
    // sync, so the provider recognises its own past reminder. If
    // someone renames the reminder copy without updating the dedup
    // fingerprint, this assertion fails and the regression is caught.
    const second = provider.getInjections(ctxWithEmitted);
    expect(second).toEqual([]);
  });
});
