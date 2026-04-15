/**
 * SessionManager — multi-session CRUD tests (§6.4).
 *
 * Rewritten from Python `tests/core/test_session.py` (create, list, find,
 * destroy, continue) to v2 SessionManager semantics. Python Session class
 * had title logic, post-run cleanup, etc. — v2 SessionManager is simpler
 * (Map<id, SoulPlus> + PathConfig).
 *
 * All tests FAIL (red bar) until Slice 5 Phase 3 implementation.
 */

import { describe, expect, it } from 'vitest';

import { PathConfig, SessionManager } from '../../src/session/index.js';

function createTestManager(): SessionManager {
  const paths = new PathConfig({ home: '/tmp/test-kimi' });
  return new SessionManager(paths);
}

// ── Create ──────────────────────────────────────────────────────────────

describe('SessionManager.create', () => {
  it('creates a session and returns it', () => {
    const manager = createTestManager();
    const session = manager.create();
    expect(session).toBeDefined();
  });

  it('creates a session with a specified id', () => {
    const manager = createTestManager();
    const session = manager.create({ session_id: 'ses_custom' });
    expect(session).toBeDefined();
    expect(manager.get('ses_custom')).toBe(session);
  });

  it('generates a unique id when not specified', () => {
    const manager = createTestManager();
    const s1 = manager.create();
    const s2 = manager.create();
    expect(s1).not.toBe(s2);
  });

  it('creates a session with optional model', () => {
    const manager = createTestManager();
    const session = manager.create({ model: 'gpt-4' });
    expect(session).toBeDefined();
  });
});

// ── Get ─────────────────────────────────────────────────────────────────

describe('SessionManager.get', () => {
  it('returns undefined for nonexistent session', () => {
    const manager = createTestManager();
    expect(manager.get('ses_nonexistent')).toBeUndefined();
  });

  it('returns created session by id', () => {
    const manager = createTestManager();
    const session = manager.create({ session_id: 'ses_abc' });
    expect(manager.get('ses_abc')).toBe(session);
  });
});

// ── Destroy ─────────────────────────────────────────────────────────────

describe('SessionManager.destroy', () => {
  it('removes session from map', async () => {
    const manager = createTestManager();
    manager.create({ session_id: 'ses_doomed' });
    expect(manager.get('ses_doomed')).toBeDefined();

    await manager.destroy('ses_doomed');
    expect(manager.get('ses_doomed')).toBeUndefined();
  });

  it('throws for nonexistent session', async () => {
    const manager = createTestManager();
    await expect(manager.destroy('ses_ghost')).rejects.toThrow();
  });
});

// ── List ─────────────────────────────────────────────────────────────────

describe('SessionManager.list', () => {
  it('returns empty array when no sessions exist', () => {
    const manager = createTestManager();
    expect(manager.list()).toEqual([]);
  });

  it('returns info for all created sessions', () => {
    const manager = createTestManager();
    manager.create({ session_id: 'ses_a' });
    manager.create({ session_id: 'ses_b' });

    const list = manager.list();
    expect(list).toHaveLength(2);
    const ids = list.map((s) => s.session_id);
    expect(ids).toContain('ses_a');
    expect(ids).toContain('ses_b');
  });

  it('includes created_at timestamp', () => {
    const manager = createTestManager();
    const before = Date.now();
    manager.create({ session_id: 'ses_timed' });
    const after = Date.now();

    const list = manager.list();
    const info = list.find((s) => s.session_id === 'ses_timed');
    expect(info).toBeDefined();
    expect(info!.created_at).toBeGreaterThanOrEqual(before);
    expect(info!.created_at).toBeLessThanOrEqual(after);
  });
});
