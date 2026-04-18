/**
 * Phase 21 §A.6.2 regression — resume must tolerate a fresh session whose
 * `wire.jsonl` was never flushed.
 *
 * `WiredJournalWriter` writes the metadata header lazily (on the first
 * `append`). A session created and immediately closed without any
 * downstream activity therefore has a session directory but **no**
 * wire.jsonl on disk. The Phase 21 §A.6.2 wire path
 * (`wireRebuildRuntimeForModel`) does `closeSession → resumeSession` and
 * was crashing with `ENOENT: ... wire.jsonl` because `replayWire` failed
 * to read the missing file.
 *
 * Resume should treat ENOENT as "empty session, start clean" rather than
 * failing the whole turn.
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

describe('SessionManager.resumeSession — fresh session (Phase 21 §A.6.2)', () => {
  it('resumes a session whose wire.jsonl was never flushed', async () => {
    const mgr = new SessionManager(paths);

    // 1. Create + immediately close — no records flushed → no wire.jsonl.
    await mgr.createSession({
      workspaceDir: tmpDir,
      sessionId: 'ses_fresh',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'model-v1',
    });
    await mgr.closeSession('ses_fresh');

    // Sanity: wire.jsonl really is missing on disk.
    expect(existsSync(paths.wirePath('ses_fresh'))).toBe(false);

    // 2. Resume must NOT throw — this is the production bug (-32603 ENOENT).
    const resumed = await mgr.resumeSession('ses_fresh', {
      runtime: createNoopRuntime(),
      tools: [],
      model: 'model-v2',
    });

    expect(resumed.sessionId).toBe('ses_fresh');
    expect(resumed.contextState.model).toBe('model-v2');
    // Empty history: no records to project.
    const messages = resumed.contextState.buildMessages();
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(0);
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  it('writes a fresh metadata header on first append after a fresh-resume', async () => {
    const mgr = new SessionManager(paths);

    await mgr.createSession({
      workspaceDir: tmpDir,
      sessionId: 'ses_fresh_meta',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'm',
    });
    await mgr.closeSession('ses_fresh_meta');
    expect(existsSync(paths.wirePath('ses_fresh_meta'))).toBe(false);

    const resumed = await mgr.resumeSession('ses_fresh_meta', {
      runtime: createNoopRuntime(),
      tools: [],
      model: 'm',
    });

    // First append should produce a wire.jsonl with a real metadata header
    // (otherwise a subsequent resume would explode again because the file
    // would start with a non-metadata record).
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
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const meta = JSON.parse(lines[0]!);
    expect(meta.type).toBe('metadata');
    expect(meta.protocol_version).toBeDefined();
    const record = JSON.parse(lines[1]!);
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
      model: 'm2',
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

    // Second resume — wire.jsonl now exists with a real header. Must
    // hydrate the turn that was written between the first resume and
    // close, proving the new header path is replay-compatible.
    const resumed2 = await mgr.resumeSession('ses_fresh_rt', {
      runtime: createNoopRuntime(),
      tools: [],
      model: 'm2',
    });
    expect(resumed2.sessionId).toBe('ses_fresh_rt');
  });
});
