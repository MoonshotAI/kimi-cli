/* oxlint-disable vitest/warn-todo -- Phase 11 intentionally records src-gap
   placeholders via `it.todo`. See MIGRATION_REPORT_phase_11.md §附录 B. */
/**
 * Covers: InMemoryApprovalStateStore + SessionStateApprovalStateStore.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// ── Phase 11.2 — onChanged callback (src decision pending) ─────────────
//
// P2 — see MIGRATION_REPORT_phase_11.md §附录 B gap #4.
// Python parity (tests/core/test_session_state.py L357/L377/L414/L448):
//   1. set_yolo flips onChanged
//   2. approve_for_session appends and fires onChanged with the added label
//   3. cascading resolve of the same action fires onChanged once, not N times
//   4. A runtime without onChanged callback must never crash
//
// Unblock recipe (when Phase 8 / 12 decides to wire the hook):
//   1. Extend `src/soul-plus/approval-state-store.ts:23-28`
//      ApprovalStateStore interface with
//      `onChanged?: (actions: ReadonlySet<string>) => void`.
//   2. Call it from InMemoryApprovalStateStore.save (line :45) and
//      SessionStateApprovalStateStore.save (line :80) AFTER the
//      persistence write succeeds (mirror-after-WAL).
//   3. Wire it through WiredApprovalRuntime.recordSessionApproval
//      (src/soul-plus/wired-approval-runtime.ts:339-353) so the cascade
//      path passes the same callback through.
//   4. Expand this todo into four passing cases (one per Python parity
//      point above) using `vi.fn()` spies on onChanged.
describe('Phase 17 B.2 — ApprovalStateStore.onChanged callback', () => {
  it('InMemoryApprovalStateStore.save with onChanged fires {kind, before, after} after persist', async () => {
    const onChanged = vi.fn();
    const store = new InMemoryApprovalStateStore();
    // Phase 17 B.2 — `onChanged` accepted as a second constructor arg
    // OR a post-construction setter. Implementer picks either shape;
    // the test asks for a setter for maximum flexibility.
    (store as unknown as {
      onChanged?: (e: {
        kind: string;
        before: ReadonlySet<string>;
        after: ReadonlySet<string>;
      }) => void;
    }).onChanged = onChanged;

    await store.save(new Set(['action_a']));

    expect(onChanged).toHaveBeenCalledTimes(1);
    const call = onChanged.mock.calls[0]![0] as {
      kind: string;
      before: ReadonlySet<string>;
      after: ReadonlySet<string>;
    };
    expect(call.before.size).toBe(0);
    expect(call.after.has('action_a')).toBe(true);
  });

  it('no crash when onChanged is not provided (undefined)', async () => {
    const store = new InMemoryApprovalStateStore();
    await expect(store.save(new Set(['a']))).resolves.toBeUndefined();
    expect((await store.load()).has('a')).toBe(true);
  });
});
