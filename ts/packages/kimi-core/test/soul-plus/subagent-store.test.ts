/**
 * SubagentStore tests — FS persistence for subagent instances.
 */

import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SubagentStore } from '../../src/soul-plus/subagent-store.js';

let tmp: string;
let store: SubagentStore;

beforeEach(async () => {
  tmp = join(tmpdir(), `kimi-subagent-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmp, { recursive: true });
  store = new SubagentStore(tmp);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('SubagentStore', () => {
  describe('createInstance', () => {
    it('creates directory structure and meta.json', async () => {
      const record = await store.createInstance({
        agentId: 'sa_test1',
        subagentType: 'coder',
        description: 'test agent',
        parentToolCallId: 'tc_123',
      });
      expect(record.agent_id).toBe('sa_test1');
      expect(record.subagent_type).toBe('coder');
      expect(record.status).toBe('created');
      expect(record.description).toBe('test agent');
      expect(record.parent_tool_call_id).toBe('tc_123');
      expect(record.created_at).toBeGreaterThan(0);

      // Verify meta.json written
      const raw = await readFile(store.metaPath('sa_test1'), 'utf-8');
      const persisted = JSON.parse(raw);
      expect(persisted.agent_id).toBe('sa_test1');
      expect(persisted.status).toBe('created');
    });

    it('creates empty wire.jsonl', async () => {
      await store.createInstance({
        agentId: 'sa_wire',
        subagentType: 'coder',
        description: 'test',
        parentToolCallId: 'tc_1',
      });
      const wire = await readFile(store.wirePath('sa_wire'), 'utf-8');
      expect(wire).toBe('');
    });
  });

  describe('getInstance', () => {
    it('returns the record after creation', async () => {
      await store.createInstance({
        agentId: 'sa_get',
        subagentType: 'explore',
        description: 'getter',
        parentToolCallId: 'tc_2',
      });
      const record = await store.getInstance('sa_get');
      expect(record).not.toBeNull();
      expect(record!.subagent_type).toBe('explore');
    });

    it('returns null for nonexistent agent', async () => {
      const record = await store.getInstance('sa_nonexistent');
      expect(record).toBeNull();
    });
  });

  describe('updateInstance', () => {
    it('patches status and bumps updated_at', async () => {
      const original = await store.createInstance({
        agentId: 'sa_update',
        subagentType: 'coder',
        description: 'updatable',
        parentToolCallId: 'tc_3',
      });
      const updated = await store.updateInstance('sa_update', { status: 'running' });
      expect(updated.status).toBe('running');
      expect(updated.updated_at).toBeGreaterThanOrEqual(original.updated_at);
      expect(updated.description).toBe('updatable'); // unchanged
    });

    it('patches description', async () => {
      await store.createInstance({
        agentId: 'sa_desc',
        subagentType: 'plan',
        description: 'old',
        parentToolCallId: 'tc_4',
      });
      const updated = await store.updateInstance('sa_desc', { description: 'new desc' });
      expect(updated.description).toBe('new desc');
    });

    it('throws for nonexistent agent', async () => {
      await expect(
        store.updateInstance('sa_ghost', { status: 'failed' }),
      ).rejects.toThrow('not found');
    });
  });

  describe('listInstances', () => {
    it('returns empty for no subagents', async () => {
      const list = await store.listInstances();
      expect(list).toEqual([]);
    });

    it('lists all instances sorted by updated_at desc', async () => {
      await store.createInstance({
        agentId: 'sa_a',
        subagentType: 'coder',
        description: 'first',
        parentToolCallId: 'tc_a',
      });
      await store.createInstance({
        agentId: 'sa_b',
        subagentType: 'explore',
        description: 'second',
        parentToolCallId: 'tc_b',
      });
      // Update sa_a to make it more recent
      await store.updateInstance('sa_a', { status: 'completed' });

      const list = await store.listInstances();
      expect(list).toHaveLength(2);
      expect(list[0]!.agent_id).toBe('sa_a'); // most recently updated
      expect(list[1]!.agent_id).toBe('sa_b');
    });
  });

  describe('path helpers', () => {
    it('instanceDir returns correct path', () => {
      expect(store.instanceDir('sa_x')).toBe(join(tmp, 'subagents', 'sa_x'));
    });

    it('metaPath returns correct path', () => {
      expect(store.metaPath('sa_x')).toBe(join(tmp, 'subagents', 'sa_x', 'meta.json'));
    });

    it('wirePath returns correct path', () => {
      expect(store.wirePath('sa_x')).toBe(join(tmp, 'subagents', 'sa_x', 'wire.jsonl'));
    });
  });
});
