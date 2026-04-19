/**
 * Phase 24 — 24b bug: thinking_level missing from replay-projector.
 *
 * Bug: `ReplayProjectedState` has no `thinkingLevel` field.
 * `projectReplayState()` ignores both:
 *   - `sessionInitialized.thinking_level` (baseline value)
 *   - `thinking_changed` records (overlay)
 *
 * Fix: add `thinkingLevel?: string | undefined` to `ReplayProjectedState`,
 * read baseline from `sessionInitialized.thinking_level`, and overlay with
 * `thinking_changed` records in the switch.
 *
 * All tests FAIL until the fix lands.
 */

import { describe, expect, it } from 'vitest';

import { projectReplayState } from '../../src/session/replay-projector.js';
import type { SessionInitializedRecord, WireRecord } from '../../src/storage/wire-record.js';

function makeMainInit(overrides?: Record<string, unknown>): SessionInitializedRecord {
  return {
    type: 'session_initialized',
    seq: 1,
    time: 1,
    agent_type: 'main',
    session_id: 'ses_think',
    system_prompt: '',
    model: 'baseline-model',
    active_tools: [],
    permission_mode: 'default',
    plan_mode: false,
    workspace_dir: '/tmp/ws',
    ...overrides,
  } as SessionInitializedRecord;
}

function makeThinkingChangedRecord(seq: number, level: string): WireRecord {
  return {
    type: 'thinking_changed',
    seq,
    time: Date.now(),
    level,
  } as WireRecord;
}

describe('Phase 24 24b — projectReplayState preserves thinking_level', () => {
  it('sessionInitialized with thinking_level=medium → projected.thinkingLevel === medium', () => {
    const init = makeMainInit({ thinking_level: 'medium' });

    const result = projectReplayState([], init);

    // FAILS NOW: result has no thinkingLevel property (undefined !== 'medium')
    expect((result as { thinkingLevel?: string }).thinkingLevel).toBe('medium');
  });

  it('sessionInitialized without thinking_level → projected.thinkingLevel is undefined', () => {
    const init = makeMainInit(); // no thinking_level

    const result = projectReplayState([], init);

    // After fix: thinkingLevel should be undefined (not an error)
    // FAILS NOW: result has no thinkingLevel property at all (accessing it returns undefined)
    // To distinguish "field absent" from "field=undefined", we check the field exists on type
    // by verifying the interface includes it — tested indirectly by type-correctness
    expect(Object.keys(result)).toContain('thinkingLevel'); // FAILS: property not present
  });

  it('sessionInitialized medium + thinking_changed:high → projected.thinkingLevel === high', () => {
    const init = makeMainInit({ thinking_level: 'medium' });
    const records: WireRecord[] = [makeThinkingChangedRecord(2, 'high')];

    const result = projectReplayState(records, init);

    // FAILS NOW: thinking_changed is not handled in switch — falls through to default:break
    expect((result as { thinkingLevel?: string }).thinkingLevel).toBe('high');
  });

  it('sessionInitialized without thinking_level + thinking_changed:high → thinkingLevel === high', () => {
    const init = makeMainInit(); // no thinking_level at startup
    const records: WireRecord[] = [makeThinkingChangedRecord(2, 'high')];

    const result = projectReplayState(records, init);

    // FAILS NOW: no baseline + no thinking_changed handling
    expect((result as { thinkingLevel?: string }).thinkingLevel).toBe('high');
  });

  it('multiple thinking_changed records → last write wins', () => {
    const init = makeMainInit({ thinking_level: 'low' });
    const records: WireRecord[] = [
      makeThinkingChangedRecord(2, 'medium'),
      makeThinkingChangedRecord(3, 'high'),
    ];

    const result = projectReplayState(records, init);

    // FAILS NOW
    expect((result as { thinkingLevel?: string }).thinkingLevel).toBe('high');
  });
});
