/**
 * StateCache — state.json read/write tests.
 *
 * Rewritten from Python `tests/core/test_session_state.py` (load, save,
 * roundtrip, resilience). Python had migration logic, concurrent write
 * protection, atomic saves — v2 StateCache is simpler for Phase 1.
 *
 * All tests FAIL (red bar) until Slice 5 Phase 3 implementation.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StateCache } from '../../src/session/index.js';
import type { SessionState } from '../../src/session/index.js';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `kimi-state-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ── Read ────────────────────────────────────────────────────────────────

describe('StateCache.read', () => {
  it('returns null when state.json does not exist', async () => {
    const cache = new StateCache(join(testDir, 'state.json'));
    const state = await cache.read();
    expect(state).toBeNull();
  });

  it('reads a valid state.json', async () => {
    const statePath = join(testDir, 'state.json');
    const data: SessionState = {
      session_id: 'ses_abc',
      created_at: 1700000000000,
      updated_at: 1700000000000,
      model: 'gpt-4',
      status: 'idle',
    };
    await writeFile(statePath, JSON.stringify(data), 'utf-8');

    const cache = new StateCache(statePath);
    const state = await cache.read();
    expect(state).not.toBeNull();
    expect(state!.session_id).toBe('ses_abc');
    expect(state!.model).toBe('gpt-4');
  });

  it('returns null for corrupted JSON', async () => {
    const statePath = join(testDir, 'state.json');
    await writeFile(statePath, '{bad json', 'utf-8');

    const cache = new StateCache(statePath);
    const state = await cache.read();
    expect(state).toBeNull();
  });

  it('returns null for empty file', async () => {
    const statePath = join(testDir, 'state.json');
    await writeFile(statePath, '', 'utf-8');

    const cache = new StateCache(statePath);
    const state = await cache.read();
    expect(state).toBeNull();
  });
});

// ── Write ───────────────────────────────────────────────────────────────

describe('StateCache.write', () => {
  it('writes state.json that can be read back', async () => {
    const statePath = join(testDir, 'state.json');
    const cache = new StateCache(statePath);

    const state: SessionState = {
      session_id: 'ses_roundtrip',
      created_at: 1700000000000,
      updated_at: 1700000001000,
      model: 'k25',
      status: 'active',
      last_turn_id: 'turn_1',
      last_turn_time: 1700000001000,
    };

    await cache.write(state);
    const loaded = await cache.read();

    expect(loaded).not.toBeNull();
    expect(loaded!.session_id).toBe('ses_roundtrip');
    expect(loaded!.model).toBe('k25');
    expect(loaded!.last_turn_id).toBe('turn_1');
  });

  it('overwrites existing state.json', async () => {
    const statePath = join(testDir, 'state.json');
    const cache = new StateCache(statePath);

    await cache.write({
      session_id: 'ses_old',
      created_at: 1700000000000,
      updated_at: 1700000000000,
    });

    await cache.write({
      session_id: 'ses_new',
      created_at: 1700000002000,
      updated_at: 1700000002000,
    });

    const loaded = await cache.read();
    expect(loaded!.session_id).toBe('ses_new');
  });
});
