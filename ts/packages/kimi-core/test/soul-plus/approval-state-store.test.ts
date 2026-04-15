/**
 * Covers: InMemoryApprovalStateStore + SessionStateApprovalStateStore.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StateCache } from '../../src/session/state-cache.js';
import {
  InMemoryApprovalStateStore,
  SessionStateApprovalStateStore,
} from '../../src/soul-plus/approval-state-store.js';

describe('InMemoryApprovalStateStore', () => {
  it('load returns an empty set by default', async () => {
    const store = new InMemoryApprovalStateStore();
    const actions = await store.load();
    expect(actions.size).toBe(0);
  });

  it('save / load round-trips the provided actions', async () => {
    const store = new InMemoryApprovalStateStore();
    await store.save(new Set(['run command', 'edit file']));
    const actions = await store.load();
    expect(actions).toEqual(new Set(['run command', 'edit file']));
  });

  it('accepts an initial iterable in the constructor', async () => {
    const store = new InMemoryApprovalStateStore(['run command']);
    const actions = await store.load();
    expect(actions.has('run command')).toBe(true);
  });
});

describe('SessionStateApprovalStateStore', () => {
  let dir: string;
  let cache: StateCache;
  let now = 1700000000000;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'slice2_3-state-'));
    cache = new StateCache(join(dir, 'state.json'));
    now = 1700000000000;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('load returns empty when state.json does not yet exist', async () => {
    const store = new SessionStateApprovalStateStore(cache, 'sess_1', () => now);
    const actions = await store.load();
    expect(actions.size).toBe(0);
  });

  it('save creates a state.json with auto_approve_actions populated', async () => {
    const store = new SessionStateApprovalStateStore(cache, 'sess_1', () => now);
    await store.save(new Set(['run command']));
    const written = await cache.read();
    expect(written?.session_id).toBe('sess_1');
    expect(written?.auto_approve_actions).toEqual(['run command']);
    expect(written?.created_at).toBe(now);
  });

  it('save preserves other session fields across writes', async () => {
    // Seed state.json with other fields.
    await cache.write({
      session_id: 'sess_1',
      model: 'kimi-latest',
      status: 'idle',
      created_at: 1,
      updated_at: 1,
    });
    const store = new SessionStateApprovalStateStore(cache, 'sess_1', () => now);
    await store.save(new Set(['edit file']));
    const written = await cache.read();
    expect(written?.model).toBe('kimi-latest');
    expect(written?.status).toBe('idle');
    expect(written?.auto_approve_actions).toEqual(['edit file']);
    expect(written?.updated_at).toBe(now);
  });

  it('load reflects the set persisted on disk', async () => {
    await cache.write({
      session_id: 'sess_1',
      auto_approve_actions: ['run command', 'edit file'],
      created_at: 1,
      updated_at: 1,
    });
    const store = new SessionStateApprovalStateStore(cache, 'sess_1', () => now);
    const actions = await store.load();
    expect(actions).toEqual(new Set(['run command', 'edit file']));
  });
});
