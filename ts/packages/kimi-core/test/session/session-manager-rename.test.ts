/**
 * SessionManager.renameSession + getSessionStatus + getSessionUsage tests.
 *
 * Read-merge-write semantics for rename: concurrent renames don't clobber
 * each other's other state.json fields.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PathConfig } from '../../src/session/path-config.js';
import { SessionManager } from '../../src/session/session-manager.js';
import type { SessionState } from '../../src/session/state-cache.js';

let tmp: string;
let mgr: SessionManager;

async function seedSession(sessionId: string, state: Partial<SessionState> = {}): Promise<void> {
  const sessionDir = join(tmp, 'sessions', sessionId);
  await mkdir(sessionDir, { recursive: true });
  const statePath = join(sessionDir, 'state.json');
  await writeFile(
    statePath,
    JSON.stringify(
      {
        session_id: sessionId,
        created_at: 1_700_000_000,
        updated_at: 1_700_000_000,
        ...state,
      },
      null,
      2,
    ),
    'utf-8',
  );
}

async function readState(sessionId: string): Promise<SessionState> {
  const statePath = join(tmp, 'sessions', sessionId, 'state.json');
  const raw = await readFile(statePath, 'utf-8');
  return JSON.parse(raw) as SessionState;
}

beforeEach(async () => {
  tmp = join(tmpdir(), `kimi-rename-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmp, { recursive: true });
  mgr = new SessionManager(new PathConfig({ home: tmp }));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// ── renameSession ─────────────────────────────────────────────────────

describe('SessionManager.renameSession', () => {
  it('writes custom_title to state.json', async () => {
    await seedSession('ses_a');
    await mgr.renameSession('ses_a', 'My demo');
    const state = await readState('ses_a');
    expect(state.custom_title).toBe('My demo');
  });

  it('preserves other state.json fields', async () => {
    await seedSession('ses_a', {
      model: 'kimi-k2.5',
      workspace_dir: '/proj',
      auto_approve_actions: ['read'],
    });
    await mgr.renameSession('ses_a', 'New title');
    const state = await readState('ses_a');
    expect(state.model).toBe('kimi-k2.5');
    expect(state.workspace_dir).toBe('/proj');
    expect(state.auto_approve_actions).toEqual(['read']);
  });

  it('updates updated_at to current time', async () => {
    await seedSession('ses_a', { updated_at: 1_700_000_000 });
    const before = Date.now();
    await mgr.renameSession('ses_a', 'New');
    const state = await readState('ses_a');
    // updated_at is ms; allow ±2s for clock skew
    expect(state.updated_at).toBeGreaterThanOrEqual(before - 2000);
  });

  it('overwrites previous title', async () => {
    await seedSession('ses_a', { custom_title: 'Old' });
    await mgr.renameSession('ses_a', 'New');
    const state = await readState('ses_a');
    expect(state.custom_title).toBe('New');
  });

  it('throws when sessionId does not exist', async () => {
    await expect(mgr.renameSession('ses_missing', 'x')).rejects.toThrow(/not found|does not exist/i);
  });

  it('rejects empty title', async () => {
    await seedSession('ses_a');
    await expect(mgr.renameSession('ses_a', '')).rejects.toThrow(/empty|invalid/i);
  });

  it('trims whitespace-only title to empty and rejects', async () => {
    await seedSession('ses_a');
    await expect(mgr.renameSession('ses_a', '   ')).rejects.toThrow(/empty|invalid/i);
  });
});

// ── getSessionStatus ──────────────────────────────────────────────────

describe('SessionManager.getSessionStatus', () => {
  it('returns idle when state.json has no status', async () => {
    await seedSession('ses_a');
    const status = await mgr.getSessionStatus('ses_a');
    expect(status).toBe('idle');
  });

  it('returns persisted status from state.json', async () => {
    await seedSession('ses_a', { status: 'active' });
    const status = await mgr.getSessionStatus('ses_a');
    expect(status).toBe('active');
  });

  it('coerces unknown persisted status to idle', async () => {
    await seedSession('ses_a', { status: 'mystery-state' });
    const status = await mgr.getSessionStatus('ses_a');
    expect(status).toBe('idle');
  });

  it('throws when sessionId does not exist', async () => {
    await expect(mgr.getSessionStatus('ses_missing')).rejects.toThrow(/not found|does not exist/i);
  });

  it('returns live lifecycle state when session is active in memory', async () => {
    // Inject a fake live ManagedSession with a controllable lifecycle
    // state machine and verify getSessionStatus reads from it instead
    // of state.json (which still says 'idle').
    await seedSession('ses_live', { status: 'idle' });
    const sm = new (await import('../../src/soul-plus/lifecycle-state-machine.js'))
      .SessionLifecycleStateMachine('idle');
    sm.transitionTo('active');
    // Inject by writing into the private `sessions` map. Cast through
    // unknown to avoid exposing internals on the public API.
    const internal = mgr as unknown as { sessions: Map<string, { lifecycleStateMachine: typeof sm }> };
    internal.sessions.set('ses_live', { lifecycleStateMachine: sm });
    expect(await mgr.getSessionStatus('ses_live')).toBe('active');
  });
});

// ── getSessionUsage ───────────────────────────────────────────────────

describe('SessionManager.getSessionUsage', () => {
  it('returns zeros when wire.jsonl is missing', async () => {
    await seedSession('ses_a');
    const usage = await mgr.getSessionUsage('ses_a');
    expect(usage).toEqual({
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
      total_cost_usd: 0,
    });
  });

  it('aggregates from wire.jsonl turn_end records', async () => {
    await seedSession('ses_a');
    const wirePath = join(tmp, 'sessions', 'ses_a', 'wire.jsonl');
    await writeFile(
      wirePath,
      [
        JSON.stringify({
          type: 'turn_end',
          seq: 1,
          time: 1,
          turn_id: 't_1',
          agent_type: 'main',
          success: true,
          reason: 'done',
          usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 10 },
        }),
        JSON.stringify({
          type: 'turn_end',
          seq: 2,
          time: 2,
          turn_id: 't_2',
          agent_type: 'main',
          success: true,
          reason: 'done',
          usage: { input_tokens: 200, output_tokens: 100, cache_write_tokens: 5 },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );
    const usage = await mgr.getSessionUsage('ses_a');
    expect(usage.total_input_tokens).toBe(300);
    expect(usage.total_output_tokens).toBe(150);
    expect(usage.total_cache_read_tokens).toBe(10);
    expect(usage.total_cache_write_tokens).toBe(5);
    expect(usage.total_cost_usd).toBe(0); // D1
  });

  it('throws when sessionId does not exist', async () => {
    await expect(mgr.getSessionUsage('ses_missing')).rejects.toThrow(/not found|does not exist/i);
  });

  it('reuses cached value within 5s window', async () => {
    await seedSession('ses_a');
    const wirePath = join(tmp, 'sessions', 'ses_a', 'wire.jsonl');
    await writeFile(
      wirePath,
      JSON.stringify({
        type: 'turn_end',
        seq: 1,
        time: 1,
        turn_id: 't_1',
        agent_type: 'main',
        success: true,
        reason: 'done',
        usage: { input_tokens: 10, output_tokens: 5 },
      }) + '\n',
      'utf-8',
    );
    const a = await mgr.getSessionUsage('ses_a');
    // Modify file but call again immediately — cache should still hit
    await writeFile(
      wirePath,
      JSON.stringify({
        type: 'turn_end',
        seq: 1,
        time: 1,
        turn_id: 't_1',
        agent_type: 'main',
        success: true,
        reason: 'done',
        usage: { input_tokens: 999, output_tokens: 999 },
      }) + '\n',
      'utf-8',
    );
    const b = await mgr.getSessionUsage('ses_a');
    expect(a).toEqual(b);
    expect(b.total_input_tokens).toBe(10);  // cached, not 999
  });

  it('rename invalidates cached usage entry', async () => {
    await seedSession('ses_a');
    const wirePath = join(tmp, 'sessions', 'ses_a', 'wire.jsonl');
    await writeFile(
      wirePath,
      JSON.stringify({
        type: 'turn_end',
        seq: 1,
        time: 1,
        turn_id: 't_1',
        agent_type: 'main',
        success: true,
        reason: 'done',
        usage: { input_tokens: 10, output_tokens: 5 },
      }) + '\n',
      'utf-8',
    );
    await mgr.getSessionUsage('ses_a');
    await mgr.renameSession('ses_a', 'New');
    // After rename, modify wire and re-read — cache should miss because rename invalidated
    await writeFile(
      wirePath,
      JSON.stringify({
        type: 'turn_end',
        seq: 1,
        time: 1,
        turn_id: 't_1',
        agent_type: 'main',
        success: true,
        reason: 'done',
        usage: { input_tokens: 999, output_tokens: 999 },
      }) + '\n',
      'utf-8',
    );
    const after = await mgr.getSessionUsage('ses_a');
    expect(after.total_input_tokens).toBe(999);
  });
});

// ── Phase 16 / 决策 #113 — setSessionTags + active/inactive rename (T6) ───

describe('SessionManager.setSessionTags (Phase 16 / T6)', () => {
  it('writes tags into state.json via the read-merge-write lock on an inactive session', async () => {
    await seedSession('ses_a', { model: 'kimi-k2.5' });
    await mgr.setSessionTags('ses_a', ['work', 'urgent']);
    const state = await readState('ses_a');
    expect(state.tags).toEqual(['work', 'urgent']);
    // model + other fields preserved through the merge.
    expect(state.model).toBe('kimi-k2.5');
  });

  it('overwrites the prior tag list (replace semantics, todo D2/D3)', async () => {
    await seedSession('ses_a', { tags: ['old', 'stale'] });
    await mgr.setSessionTags('ses_a', ['fresh']);
    const state = await readState('ses_a');
    expect(state.tags).toEqual(['fresh']);
  });

  it('throws when the session does not exist', async () => {
    await expect(mgr.setSessionTags('ses_missing', ['x'])).rejects.toThrow(
      /not found|does not exist/i,
    );
  });
});

describe('SessionManager.renameSession interaction with SessionMetaService (Phase 16 / T6)', () => {
  it('an inactive-session rename still lands custom_title in state.json (fallback path)', async () => {
    // Non-active sessions route through the fallback that writes state.json
    // directly (todo Step 4.1 trade-off). wire.jsonl is NOT touched in this
    // branch; the D7 clean-exit strategy tolerates the gap.
    await seedSession('ses_inactive');
    await mgr.renameSession('ses_inactive', 'fallback-title');
    const state = await readState('ses_inactive');
    expect(state.custom_title).toBe('fallback-title');
  });

  it('concurrent rename + setSessionTags serialise through withStateLock', async () => {
    await seedSession('ses_a', { model: 'kimi-k2.5' });
    // Fire both simultaneously; either order is valid as long as BOTH fields
    // end up on disk (no clobber).
    await Promise.all([
      mgr.renameSession('ses_a', 'race-title'),
      mgr.setSessionTags('ses_a', ['a', 'b']),
    ]);
    const state = await readState('ses_a');
    expect(state.custom_title).toBe('race-title');
    expect(state.tags).toEqual(['a', 'b']);
    expect(state.model).toBe('kimi-k2.5');
  });
});
