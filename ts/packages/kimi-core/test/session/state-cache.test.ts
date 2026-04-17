/**
 * StateCache — state.json read/write tests.
 *
 * Rewritten from Python `tests/core/test_session_state.py` (load, save,
 * roundtrip, resilience). Python had migration logic, concurrent write
 * protection, atomic saves — v2 StateCache is simpler for Phase 1.
 *
 * All tests FAIL (red bar) until Slice 5 Phase 3 implementation.
 */

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
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

// ── Phase 11.2 — resilience + atomic + custom_title ─────────────────────

describe('StateCache — Phase 11.2 resilience', () => {
  it('returns null when the file contains a truncated JSON payload', async () => {
    // Python parity: tests/core/test_session_state.py L271 (truncated file).
    const statePath = join(testDir, 'state.json');
    const state: SessionState = {
      session_id: 'ses_trunc',
      created_at: 1700000000000,
      updated_at: 1700000000000,
      model: 'k25',
    };
    const full = JSON.stringify(state);
    await writeFile(statePath, full.slice(0, Math.floor(full.length / 2)), 'utf-8');

    const cache = new StateCache(statePath);
    expect(await cache.read()).toBeNull();
  });

  it('returns null when bytes are binary garbage (invalid UTF-8)', async () => {
    // Python parity: L306 binary garbage.
    const statePath = join(testDir, 'state.json');
    await writeFile(
      statePath,
      Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x80, 0x81, 0x82, 0x83, 0x84, 0x85]),
    );

    const cache = new StateCache(statePath);
    expect(await cache.read()).toBeNull();
  });

  it('preserves the previous state.json when a subsequent write throws', async () => {
    // Python parity: L319 failed-write keeps the old file.
    // `atomicWrite` writes via tmp + rename — if we never reach rename, the
    // target is untouched. Simulate by passing an invalid payload type via
    // the underlying atomicWrite path; easier to simulate by pointing the
    // cache at a path whose parent does not exist AFTER the first write.
    const statePath = join(testDir, 'state.json');
    const cache = new StateCache(statePath);
    await cache.write({
      session_id: 'ses_original',
      created_at: 1700000000000,
      updated_at: 1700000000000,
      model: 'k25',
    });

    // Remove the parent after the first successful write. The next write
    // will throw at the atomicWrite stage; the target file vanished along
    // with the parent — but we can express the invariant differently:
    // rebuild the parent and seed it with the "previous" file, then attempt
    // a write that fails because we pass a payload containing a value that
    // cannot be serialised by JSON (circular reference). atomicWrite should
    // propagate the JSON.stringify throw before the temp file replaces the
    // target, so the original file remains intact.
    const circular: Record<string, unknown> = { session_id: 'ses_bad' };
    circular['self'] = circular;
    await expect(
      cache.write(circular as unknown as SessionState),
    ).rejects.toThrow();

    const after = await cache.read();
    expect(after).not.toBeNull();
    expect(after!.session_id).toBe('ses_original');
  });
});

describe('StateCache — Phase 11.2 atomic save', () => {
  it('leaves no *.tmp.* sibling after a successful write', async () => {
    // Python parity: L317 — tmp file must be renamed or cleaned.
    const statePath = join(testDir, 'state.json');
    const cache = new StateCache(statePath);
    await cache.write({
      session_id: 'ses_atomic',
      created_at: 1700000000000,
      updated_at: 1700000000000,
    });

    const entries = await readdir(testDir);
    const tmps = entries.filter((name) => name.startsWith('state.json.tmp.'));
    expect(tmps).toEqual([]);
    expect(entries).toContain('state.json');
  });

  it('leaves no *.tmp.* sibling after a failed write', async () => {
    // Python parity: L328 — tmp file is cleaned even when the write errors.
    const statePath = join(testDir, 'state.json');
    const cache = new StateCache(statePath);
    const circular: Record<string, unknown> = { session_id: 'ses_bad' };
    circular['self'] = circular;
    await expect(
      cache.write(circular as unknown as SessionState),
    ).rejects.toThrow();

    const entries = await readdir(testDir);
    const tmps = entries.filter((name) => name.startsWith('state.json.tmp.'));
    expect(tmps).toEqual([]);
  });
});

describe('StateCache — Phase 11.2 custom_title roundtrip', () => {
  it('persists custom_title and reads it back unchanged', async () => {
    // Python parity: L95 `/title` command roundtrip.
    const statePath = join(testDir, 'state.json');
    const cache = new StateCache(statePath);
    await cache.write({
      session_id: 'ses_title',
      created_at: 1700000000000,
      updated_at: 1700000000000,
      custom_title: 'Migrate Phase 11 tests',
    });

    const loaded = await cache.read();
    expect(loaded!.custom_title).toBe('Migrate Phase 11 tests');
  });
});

// ── Phase 11.2 — schema-failure contract ──────────────────────────────
//
// Phase 11 locks the CURRENT v2 contract: `StateCache.read()` is a
// permissive `JSON.parse` cast — an object that parses cleanly but
// does not match `SessionState` is returned as-is (no schema rejection,
// no default fallback). Python's "default + logger.warn" fallback is a
// future product decision; when it ships, the owning PR will replace
// this assertion and remove the todo below.
describe('StateCache — Phase 11.2 schema-failure contract', () => {
  it('returns the parsed object even when required SessionState fields are missing (permissive read)', async () => {
    const statePath = join(testDir, 'state.json');
    // Parses as JSON but is not a valid SessionState (missing session_id / timestamps).
    await writeFile(statePath, JSON.stringify({ model: 'k25' }), 'utf-8');

    const cache = new StateCache(statePath);
    const loaded = await cache.read();
    // Current contract is a plain cast: reader returns whatever parsed.
    // If a future PR introduces schema validation + default fallback,
    // flip this to `expect(loaded).toMatchObject({...defaults})`.
    expect(loaded).toMatchObject({ model: 'k25' });
  });
});
