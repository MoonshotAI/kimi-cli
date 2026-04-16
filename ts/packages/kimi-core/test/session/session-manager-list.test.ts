/**
 * SessionManager.listSessions — Slice 5.1 fields (title + last_activity).
 *
 * Verifies that listSessions populates the new optional fields by reading
 * the state.json `custom_title` and the file's mtime. Sessions without a
 * state.json (corrupt / legacy) still appear with undefined fields.
 */

import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PathConfig } from '../../src/session/path-config.js';
import { SessionManager } from '../../src/session/session-manager.js';
import type { SessionState } from '../../src/session/state-cache.js';

let tmp: string;
let mgr: SessionManager;

async function writeSessionState(sessionId: string, state: Partial<SessionState>): Promise<string> {
  const sessionsDir = join(tmp, 'sessions');
  const sessionDir = join(sessionsDir, sessionId);
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
  return statePath;
}

beforeEach(async () => {
  tmp = join(tmpdir(), `kimi-list-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmp, { recursive: true });
  mgr = new SessionManager(new PathConfig({ home: tmp }));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('SessionManager.listSessions — Slice 5.1 fields', () => {
  it('populates title from state.custom_title', async () => {
    await writeSessionState('ses_a', { custom_title: 'My research project' });
    const list = await mgr.listSessions();
    const ses = list.find((s) => s.session_id === 'ses_a');
    expect(ses?.title).toBe('My research project');
  });

  it('title is undefined when no custom_title is set', async () => {
    await writeSessionState('ses_b', {});
    const list = await mgr.listSessions();
    const ses = list.find((s) => s.session_id === 'ses_b');
    expect(ses?.title).toBeUndefined();
  });

  it('populates last_activity from state.json mtime', async () => {
    const statePath = await writeSessionState('ses_c', {});
    const target = new Date(1_700_010_000 * 1000);
    await utimes(statePath, target, target);
    const list = await mgr.listSessions();
    const ses = list.find((s) => s.session_id === 'ses_c');
    expect(ses?.last_activity).toBeDefined();
    // Allow ±2s tolerance for FS timestamp granularity
    expect(ses!.last_activity!).toBeGreaterThanOrEqual(1_700_010_000 - 2);
    expect(ses!.last_activity!).toBeLessThanOrEqual(1_700_010_000 + 2);
  });

  it('last_activity is undefined when state.json is missing', async () => {
    // Create a session dir without state.json
    const sessionDir = join(tmp, 'sessions', 'ses_no_state');
    await mkdir(sessionDir, { recursive: true });
    const list = await mgr.listSessions();
    const ses = list.find((s) => s.session_id === 'ses_no_state');
    expect(ses?.last_activity).toBeUndefined();
    expect(ses?.title).toBeUndefined();
  });

  it('returns empty list when sessions dir does not exist', async () => {
    // No write — sessionsDir was never created
    const list = await mgr.listSessions();
    expect(list).toEqual([]);
  });

  it('preserves existing fields (session_id / created_at / model / workspace_dir)', async () => {
    await writeSessionState('ses_full', {
      created_at: 1_700_000_000,
      model: 'kimi-k2.5',
      workspace_dir: '/home/user/proj',
      custom_title: 'Demo',
    });
    const list = await mgr.listSessions();
    const ses = list.find((s) => s.session_id === 'ses_full');
    expect(ses).toMatchObject({
      session_id: 'ses_full',
      created_at: 1_700_000_000,
      model: 'kimi-k2.5',
      workspace_dir: '/home/user/proj',
      title: 'Demo',
    });
  });
});
