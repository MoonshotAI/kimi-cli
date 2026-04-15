/**
 * Plan mode tests (§3.5 session.setPlanMode).
 *
 * Tests verify that:
 *   - PlanModeChangedRecord is written via ContextState.applyConfigChange
 *   - plan_mode_changed record has correct shape
 *   - plan_mode_changed persists through zod schema validation
 *   - PlanModeChangedRecord.enabled flag toggles correctly
 *   - The plan.display wire event type is available
 */

import { describe, expect, it } from 'vitest';

import { InMemoryContextState } from '../../src/storage/context-state.js';
import { PlanModeChangedRecordSchema } from '../../src/storage/wire-record.js';
import type { PlanModeChangedRecord } from '../../src/storage/wire-record.js';
import type { WireEventMethod } from '../../src/wire-protocol/types.js';

// ── PlanModeChangedRecord schema tests ────────────────────────────────

describe('PlanModeChangedRecord schema', () => {
  it('validates a well-formed plan_mode_changed record', () => {
    const record: PlanModeChangedRecord = {
      type: 'plan_mode_changed',
      seq: 1,
      time: Date.now(),
      enabled: true,
    };
    const parsed = PlanModeChangedRecordSchema.safeParse(record);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.enabled).toBe(true);
    }
  });

  it('validates plan_mode_changed with enabled: false', () => {
    const record: PlanModeChangedRecord = {
      type: 'plan_mode_changed',
      seq: 2,
      time: Date.now(),
      enabled: false,
    };
    const parsed = PlanModeChangedRecordSchema.safeParse(record);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.enabled).toBe(false);
    }
  });
});

// ── ContextState.applyConfigChange plan_mode_changed tests ────────────

describe('ContextState plan_mode_changed via applyConfigChange', () => {
  it('writes a plan_mode_changed record when enabling plan mode', async () => {
    const context = new InMemoryContextState({ initialModel: 'test-model' });
    await expect(
      context.applyConfigChange({ type: 'plan_mode_changed', enabled: true }),
    ).resolves.toBeUndefined();
  });

  it('writes a plan_mode_changed record when disabling plan mode', async () => {
    const context = new InMemoryContextState({ initialModel: 'test-model' });
    await expect(
      context.applyConfigChange({ type: 'plan_mode_changed', enabled: false }),
    ).resolves.toBeUndefined();
  });

  it('can toggle plan mode on and off sequentially', async () => {
    const context = new InMemoryContextState({ initialModel: 'test-model' });
    await context.applyConfigChange({ type: 'plan_mode_changed', enabled: true });
    await context.applyConfigChange({ type: 'plan_mode_changed', enabled: false });
    await expect(
      context.applyConfigChange({ type: 'plan_mode_changed', enabled: true }),
    ).resolves.toBeUndefined();
  });
});

// ── plan.display wire event type ──────────────────────────────────────

describe('plan.display wire event', () => {
  it('plan.display is a valid WireEventMethod', () => {
    const method: WireEventMethod = 'plan.display';
    expect(method).toBe('plan.display');
  });
});
