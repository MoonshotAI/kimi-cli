/**
 * Phase 23 — create → close → resume round-trips cleanly for a session
 * that never wrote any body records.
 *
 * Historical note: Phase 21 §A.6.2 added a "fresh-resume" path to tolerate
 * a missing `wire.jsonl` (the writer used to lazy-write the metadata
 * header). Phase 23 eliminates that edge case by force-flushing
 * `session_initialized` on line 2 inside `createSession`, so every valid
 * session directory has a real wire.jsonl with ≥2 lines on disk before
 * createSession returns. The path under test here is still real — a
 * session can be opened, closed, and reopened without any Soul activity
 * between — but the mechanism is simpler: resume replays the persisted
 * baseline instead of synthesising one.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PathConfig } from '../../src/session/path-config.js';
import { SessionManager } from '../../src/session/session-manager.js';
import type { Runtime } from '../../src/soul/runtime.js';
import { createFakeRuntime } from '../soul/fixtures/fake-runtime.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';

function createNoopRuntime(): Runtime {
  const kosong = new ScriptedKosongAdapter({ responses: [] });
  return createFakeRuntime({ kosong }).runtime;
}

let tmpDir: string;
let paths: PathConfig;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kimi-resume-fresh-'));
  paths = new PathConfig({ home: tmpDir });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('SessionManager.resumeSession — fresh session (Phase 23)', () => {
  it('resumes a just-created session cleanly using the force-flushed baseline', async () => {
    const mgr = new SessionManager(paths);

    // 1. Create + immediately close.
    await mgr.createSession({
      workspaceDir: tmpDir,
      sessionId: 'ses_fresh',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'model-v1',
    });
    await mgr.closeSession('ses_fresh');

    // Phase 23 — session_initialized is force-flushed inside createSession,
    // so wire.jsonl is already on disk before we ever reach resume.
    expect(existsSync(paths.wirePath('ses_fresh'))).toBe(true);

    // 2. Resume reads the baseline from wire; no options.model fallback.
    const resumed = await mgr.resumeSession('ses_fresh', {
      runtime: createNoopRuntime(),
      tools: [],
    });

    expect(resumed.sessionId).toBe('ses_fresh');
    expect(resumed.contextState.model).toBe('model-v1');
    // Empty history: no records to project.
    const messages = resumed.contextState.buildMessages();
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(0);
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  it('preserves wire layout across create → close → resume → first append', async () => {
    const mgr = new SessionManager(paths);

    await mgr.createSession({
      workspaceDir: tmpDir,
      sessionId: 'ses_fresh_meta',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'm',
    });
    await mgr.closeSession('ses_fresh_meta');
    expect(existsSync(paths.wirePath('ses_fresh_meta'))).toBe(true);

    const resumed = await mgr.resumeSession('ses_fresh_meta', {
      runtime: createNoopRuntime(),
      tools: [],
    });

    // First body append after resume must NOT rewrite a metadata or
    // session_initialized line — both are already on disk from createSession.
    await resumed.sessionJournal.appendTurnBegin({
      type: 'turn_begin',
      turn_id: 'turn_after_fresh_resume',
      agent_type: 'main',
      user_input: 'hello',
      input_kind: 'user',
    });
    await resumed.journalWriter.flush();

    const wireContent = await readFile(paths.wirePath('ses_fresh_meta'), 'utf-8');
    const lines = wireContent.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const meta = JSON.parse(lines[0]!);
    expect(meta.type).toBe('metadata');
    expect(meta.protocol_version).toBeDefined();
    const init = JSON.parse(lines[1]!);
    expect(init.type).toBe('session_initialized');
    expect(init.agent_type).toBe('main');
    const record = JSON.parse(lines[2]!);
    expect(record.type).toBe('turn_begin');
    expect(record.turn_id).toBe('turn_after_fresh_resume');
  });

  it('a second resume after the first append still works (round-trip)', async () => {
    const mgr = new SessionManager(paths);

    await mgr.createSession({
      workspaceDir: tmpDir,
      sessionId: 'ses_fresh_rt',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'm1',
    });
    await mgr.closeSession('ses_fresh_rt');

    const resumed1 = await mgr.resumeSession('ses_fresh_rt', {
      runtime: createNoopRuntime(),
      tools: [],
    });
    await resumed1.sessionJournal.appendTurnBegin({
      type: 'turn_begin',
      turn_id: 'turn_rt',
      agent_type: 'main',
      user_input: 'hi',
      input_kind: 'user',
    });
    await resumed1.journalWriter.flush();
    await mgr.closeSession('ses_fresh_rt');

    // Second resume — baseline + body records are on disk; must hydrate
    // the turn that was written between the first resume and close.
    const resumed2 = await mgr.resumeSession('ses_fresh_rt', {
      runtime: createNoopRuntime(),
      tools: [],
    });
    expect(resumed2.sessionId).toBe('ses_fresh_rt');
  });
});
