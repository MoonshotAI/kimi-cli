/**
 * Covers: replay adapting to Phase 6 subagent lifecycle records
 * (v2 §3.6.1 / §4.1.1 / §8.4 / 决策 #88).
 *
 * Post-Phase-6 replay semantics:
 *   - `subagent_spawned` / `subagent_completed` / `subagent_failed` are
 *     KNOWN record types; they appear in the `records` output alongside
 *     the rest of the wire rows, ordered by seq.
 *   - The parent wire does NOT auto-replay the child wire. Replay simply
 *     surfaces the lifecycle references; walking into
 *     `subagents/<agent_id>/wire.jsonl` is a separate higher-level
 *     concern (see v2 §8.2 — up to SessionManager / Recovery to decide
 *     which children to hydrate).
 *   - A stray legacy `subagent_event` line (left over from pre-Phase-6
 *     sessions) is NOT in the known record set anymore. It must fall
 *     into the "unknown record type" branch — replay SKIPs it with a
 *     warning, never crashes, never marks the session broken.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { replayWire } from '../../src/storage/replay.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'kimi-replay-sub-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeWire(lines: string[]): Promise<string> {
  const path = join(workDir, 'wire.jsonl');
  await writeFile(path, lines.map((l) => l + '\n').join(''), 'utf8');
  return path;
}

function metadata(version = '2.1'): string {
  return JSON.stringify({
    type: 'metadata',
    protocol_version: version,
    created_at: 1712790000000,
    kimi_version: '1.0.0',
  });
}

describe('replayWire — subagent_spawned / subagent_completed (Phase 6 happy path)', () => {
  it('replays a spawned → completed pair without warnings or broken health', async () => {
    const path = await writeWire([
      metadata(),
      JSON.stringify({
        type: 'turn_begin',
        seq: 1,
        time: 1,
        turn_id: 't1',
        agent_type: 'main',
        input_kind: 'user',
        user_input: 'spawn something',
      }),
      JSON.stringify({
        type: 'subagent_spawned',
        seq: 2,
        time: 2,
        data: {
          agent_id: 'sub_abc',
          agent_name: 'code-reviewer',
          parent_tool_call_id: 'tc_1',
          run_in_background: false,
        },
      }),
      JSON.stringify({
        type: 'subagent_completed',
        seq: 3,
        time: 3,
        data: {
          agent_id: 'sub_abc',
          parent_tool_call_id: 'tc_1',
          result_summary: 'review done',
        },
      }),
      JSON.stringify({
        type: 'turn_end',
        seq: 4,
        time: 4,
        turn_id: 't1',
        agent_type: 'main',
        success: true,
        reason: 'done',
      }),
    ]);

    const result = await replayWire(path, { supportedMajor: 2 });
    expect(result.health).toBe('ok');
    expect(result.warnings).toEqual([]);

    const types = result.records.map((r) => r.type);
    expect(types).toEqual(['turn_begin', 'subagent_spawned', 'subagent_completed', 'turn_end']);
  });

  it('replay exposes the lifecycle records but does NOT auto-read the child wire', async () => {
    // Only the parent wire is provided to replayWire; it must not try to
    // open or infer any child subagents/<agent_id>/wire.jsonl path.
    const path = await writeWire([
      metadata(),
      JSON.stringify({
        type: 'subagent_spawned',
        seq: 1,
        time: 1,
        data: {
          agent_id: 'sub_missing_child',
          parent_tool_call_id: 'tc_1',
          run_in_background: false,
        },
      }),
    ]);

    const result = await replayWire(path, { supportedMajor: 2 });
    expect(result.health).toBe('ok');
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.type).toBe('subagent_spawned');
  });

  it('recursive subagent spawn (parent_agent_id set) replays cleanly', async () => {
    const path = await writeWire([
      metadata(),
      JSON.stringify({
        type: 'subagent_spawned',
        seq: 1,
        time: 1,
        data: {
          agent_id: 'sub_B',
          parent_tool_call_id: 'tc_inner',
          parent_agent_id: 'sub_A',
          run_in_background: false,
        },
      }),
    ]);
    const result = await replayWire(path, { supportedMajor: 2 });
    expect(result.health).toBe('ok');
    expect(result.records).toHaveLength(1);
    const record = result.records[0];
    expect(record?.type).toBe('subagent_spawned');
    if (record?.type === 'subagent_spawned') {
      expect(record.data.parent_agent_id).toBe('sub_A');
    }
  });
});

describe('replayWire — subagent_failed (Phase 6 error path)', () => {
  it('replays a spawned → failed pair with the human-readable error', async () => {
    const path = await writeWire([
      metadata(),
      JSON.stringify({
        type: 'subagent_spawned',
        seq: 1,
        time: 1,
        data: {
          agent_id: 'sub_bad',
          parent_tool_call_id: 'tc_1',
          run_in_background: false,
        },
      }),
      JSON.stringify({
        type: 'subagent_failed',
        seq: 2,
        time: 2,
        data: {
          agent_id: 'sub_bad',
          parent_tool_call_id: 'tc_1',
          error: 'upstream explosion',
        },
      }),
    ]);

    const result = await replayWire(path, { supportedMajor: 2 });
    expect(result.health).toBe('ok');
    const failed = result.records.find((r) => r.type === 'subagent_failed');
    expect(failed).toBeDefined();
    if (failed?.type === 'subagent_failed') {
      expect(failed.data.error).toMatch(/upstream/);
    }
  });
});

describe('replayWire — legacy subagent_event skipped + warned (never crashes)', () => {
  // 决策 #88: `subagent_event` is gone. A pre-Phase-6 wire.jsonl may still
  // contain such a line when users upgrade across the Slice boundary.
  // Replay must degrade gracefully: skip the row, add a warning, keep
  // processing subsequent records, and never mark the session broken.

  it('a mid-file legacy subagent_event line is skipped with a warning', async () => {
    const path = await writeWire([
      metadata(),
      JSON.stringify({
        type: 'user_message',
        seq: 1,
        time: 1,
        turn_id: 't1',
        content: 'before',
      }),
      JSON.stringify({
        type: 'subagent_event',
        seq: 2,
        time: 2,
        agent_id: 'sub_legacy',
        parent_tool_call_id: 'tc_old',
        sub_event: { type: 'step.begin', index: 0 },
      }),
      JSON.stringify({
        type: 'user_message',
        seq: 3,
        time: 3,
        turn_id: 't1',
        content: 'after',
      }),
    ]);

    const result = await replayWire(path, { supportedMajor: 2 });
    expect(result.health).toBe('ok');
    expect(result.records.map((r) => r.type)).toEqual(['user_message', 'user_message']);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.join('\n')).toMatch(/subagent_event|unknown|unrecognized/i);
  });

  it('a legacy subagent_event at the tail does not corrupt the replay', async () => {
    const path = await writeWire([
      metadata(),
      JSON.stringify({
        type: 'turn_begin',
        seq: 1,
        time: 1,
        turn_id: 't1',
        agent_type: 'main',
        input_kind: 'user',
        user_input: 'hi',
      }),
      JSON.stringify({
        type: 'subagent_event',
        seq: 2,
        time: 2,
        agent_id: 'sub_legacy',
        parent_tool_call_id: 'tc_old',
        sub_event: { type: 'step.end' },
      }),
    ]);

    const result = await replayWire(path, { supportedMajor: 2 });
    expect(result.health).toBe('ok');
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.type).toBe('turn_begin');
  });
});
