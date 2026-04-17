/**
 * Subagent recovery tests — cleanupStaleSubagents.
 */

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SubagentStore } from '../../src/soul-plus/subagent-store.js';
import { cleanupStaleSubagents } from '../../src/soul-plus/subagent-runner.js';

let tmp: string;
let store: SubagentStore;

beforeEach(async () => {
  tmp = join(tmpdir(), `kimi-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmp, { recursive: true });
  store = new SubagentStore(tmp);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('cleanupStaleSubagents', () => {
  // Slice 5.3 A1 — v2 §8.2 says residual `status='running'` records are
  // marked `'lost'` (not `'failed'`; `'failed'` is reserved for runtime
  // errors). The Python implementation writes `'failed'`; TS follows v2.
  it('marks running instances as lost', async () => {
    await store.createInstance({
      agentId: 'sa_stale1',
      subagentType: 'coder',
      description: 'stale',
      parentToolCallId: 'tc_1',
    });
    await store.updateInstance('sa_stale1', { status: 'running' });

    const staleIds = await cleanupStaleSubagents(store);
    expect(staleIds).toEqual(['sa_stale1']);

    const record = await store.getInstance('sa_stale1');
    expect(record!.status).toBe('lost');
  });

  it('does not affect completed instances', async () => {
    await store.createInstance({
      agentId: 'sa_done',
      subagentType: 'coder',
      description: 'done',
      parentToolCallId: 'tc_2',
    });
    await store.updateInstance('sa_done', { status: 'completed' });

    const staleIds = await cleanupStaleSubagents(store);
    expect(staleIds).toEqual([]);

    const record = await store.getInstance('sa_done');
    expect(record!.status).toBe('completed');
  });

  it('does not affect created instances', async () => {
    await store.createInstance({
      agentId: 'sa_new',
      subagentType: 'explore',
      description: 'new',
      parentToolCallId: 'tc_3',
    });

    const staleIds = await cleanupStaleSubagents(store);
    expect(staleIds).toEqual([]);
  });

  it('handles multiple stale instances', async () => {
    for (const id of ['sa_s1', 'sa_s2', 'sa_s3']) {
      await store.createInstance({
        agentId: id,
        subagentType: 'coder',
        description: 'stale',
        parentToolCallId: `tc_${id}`,
      });
      await store.updateInstance(id, { status: 'running' });
    }

    const staleIds = await cleanupStaleSubagents(store);
    expect(staleIds).toHaveLength(3);
    for (const id of staleIds) {
      const record = await store.getInstance(id);
      expect(record!.status).toBe('lost');
    }
  });

  it('returns empty array for no subagents', async () => {
    const staleIds = await cleanupStaleSubagents(store);
    expect(staleIds).toEqual([]);
  });
});
