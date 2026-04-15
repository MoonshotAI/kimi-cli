/**
 * SessionManager — real session lifecycle tests (Slice 3.4).
 *
 * Tests verify:
 *   - createSession: sessionDir created, wire.jsonl metadata header, state.json
 *   - resumeSession: replay → ContextState hydrated with messages
 *   - listSessions: scans sessionsDir, returns SessionInfo[]
 *   - deleteSession: rm -rf sessionDir
 *   - closeSession: flush state.json + remove from active map
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PathConfig } from '../../src/session/path-config.js';
import { SessionManager } from '../../src/session/session-manager.js';
import type { Runtime } from '../../src/soul/runtime.js';
import { createFakeRuntime } from '../soul/fixtures/fake-runtime.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';

// ── Test helpers ────────────────────────────────────────────────────

function createNoopRuntime(): Runtime {
  const kosong = new ScriptedKosongAdapter({ responses: [] });
  return createFakeRuntime({ kosong }).runtime;
}

let tmpDir: string;
let paths: PathConfig;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kimi-sm-'));
  paths = new PathConfig({ home: tmpDir });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── createSession ──────────────────────────────────────────────────

describe('SessionManager.createSession', () => {
  it('creates session directory and state.json', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
      systemPrompt: 'You are a test agent.',
    });

    expect(session.sessionId).toBeDefined();
    expect(existsSync(paths.sessionDir(session.sessionId))).toBe(true);

    // state.json should exist and contain session metadata.
    const stateRaw = await readFile(paths.statePath(session.sessionId), 'utf-8');
    const state = JSON.parse(stateRaw);
    expect(state.session_id).toBe(session.sessionId);
    expect(state.model).toBe('test-model');
    expect(state.status).toBe('active');
  });

  it('uses custom sessionId when provided', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_custom123',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
    });

    expect(session.sessionId).toBe('ses_custom123');
    expect(existsSync(paths.sessionDir('ses_custom123'))).toBe(true);
  });

  it('rejects duplicate session id', async () => {
    const mgr = new SessionManager(paths);
    await mgr.createSession({
      sessionId: 'ses_dup',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
    });

    await expect(
      mgr.createSession({
        sessionId: 'ses_dup',
        runtime: createNoopRuntime(),
        tools: [],
        model: 'test-model',
      }),
    ).rejects.toThrow('Session already exists');
  });

  it('writes wire.jsonl metadata header on first journal append', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_wire',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
      systemPrompt: 'Hello',
    });

    // Trigger a journal write by appending a user message via contextState.
    // We need to go through the sessionJournal (management class) to trigger
    // a write without needing a full turn.
    await session.sessionJournal.appendTurnBegin({
      type: 'turn_begin',
      turn_id: 'turn_test',
      agent_type: 'main',
      user_input: 'hello',
      input_kind: 'user',
    });

    const wireContent = await readFile(paths.wirePath('ses_wire'), 'utf-8');
    const lines = wireContent.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);

    // First line is the metadata header.
    const meta = JSON.parse(lines[0]!);
    expect(meta.type).toBe('metadata');
    expect(meta.protocol_version).toBeDefined();

    // Second line is the turn_begin record.
    const record = JSON.parse(lines[1]!);
    expect(record.type).toBe('turn_begin');
    expect(record.turn_id).toBe('turn_test');
  });

  it('exposes contextState with correct model and systemPrompt', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      runtime: createNoopRuntime(),
      tools: [],
      model: 'gpt-4',
      systemPrompt: 'You are helpful.',
    });

    expect(session.contextState.model).toBe('gpt-4');
    expect(session.contextState.systemPrompt).toBe('You are helpful.');
  });

  it('get() returns the session after create', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_get',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test',
    });

    expect(mgr.get('ses_get')).toBe(session);
    expect(mgr.get('ses_nonexistent')).toBeUndefined();
  });
});

// ── resumeSession ──────────────────────────────────────────────────

describe('SessionManager.resumeSession', () => {
  it('resumes a session from wire.jsonl', async () => {
    const mgr = new SessionManager(paths);

    // 1. Create a session and write some records.
    const created = await mgr.createSession({
      sessionId: 'ses_resume',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'model-v1',
      systemPrompt: 'Initial prompt.',
    });

    // Write user + assistant messages via the journal writer (bypassing Soul).
    await created.contextState.appendUserMessage({ text: 'hello' }, 'turn_1');
    await created.contextState.appendAssistantMessage({
      text: 'Hi there!',
      think: null,
      toolCalls: [],
      model: 'model-v1',
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    // 2. Close the session.
    await mgr.closeSession('ses_resume');
    expect(mgr.get('ses_resume')).toBeUndefined();

    // 3. Resume.
    const resumed = await mgr.resumeSession('ses_resume', {
      runtime: createNoopRuntime(),
      tools: [],
      model: 'model-v1',
      systemPrompt: 'Initial prompt.',
    });

    expect(resumed.sessionId).toBe('ses_resume');

    // 4. Verify ContextState was hydrated with messages.
    const messages = resumed.contextState.buildMessages();
    // Messages should include the user message and assistant message
    // from the original session. The exact count depends on projection
    // (system prompt injection, etc.), but the user + assistant should
    // be present.
    const userMsgs = messages.filter((m) => m.role === 'user');
    const assistantMsgs = messages.filter((m) => m.role === 'assistant');
    expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);

    // Token count should reflect the replayed usage.
    expect(resumed.contextState.tokenCountWithPending).toBe(150);
  });

  it('restores model from model_changed record', async () => {
    const mgr = new SessionManager(paths);

    const created = await mgr.createSession({
      sessionId: 'ses_model',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'old-model',
    });

    // Simulate a model change via config change.
    await created.contextState.applyConfigChange({
      type: 'model_changed',
      old_model: 'old-model',
      new_model: 'new-model',
    });

    await mgr.closeSession('ses_model');

    const resumed = await mgr.resumeSession('ses_model', {
      runtime: createNoopRuntime(),
      tools: [],
      model: 'old-model', // fallback
    });

    expect(resumed.contextState.model).toBe('new-model');
  });

  it('throws when session wire.jsonl does not exist', async () => {
    const mgr = new SessionManager(paths);

    await expect(
      mgr.resumeSession('ses_ghost', {
        runtime: createNoopRuntime(),
        tools: [],
        model: 'test',
      }),
    ).rejects.toThrow('Failed to replay session ses_ghost');
  });

  it('rejects resume of already-active session', async () => {
    const mgr = new SessionManager(paths);

    await mgr.createSession({
      sessionId: 'ses_active',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test',
    });

    await expect(
      mgr.resumeSession('ses_active', {
        runtime: createNoopRuntime(),
        tools: [],
        model: 'test',
      }),
    ).rejects.toThrow('Session already active');
  });
});

// ── listSessions ──────────────────────────────────────────────────

describe('SessionManager.listSessions', () => {
  it('returns empty array when no sessions exist', async () => {
    const mgr = new SessionManager(paths);
    const list = await mgr.listSessions();
    expect(list).toEqual([]);
  });

  it('lists created sessions from filesystem', async () => {
    const mgr = new SessionManager(paths);

    await mgr.createSession({
      sessionId: 'ses_list_a',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'model-a',
    });

    await mgr.createSession({
      sessionId: 'ses_list_b',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'model-b',
    });

    // Close both so they have state.json flushed.
    await mgr.closeSession('ses_list_a');
    await mgr.closeSession('ses_list_b');

    // Use a fresh manager (simulates restart).
    const freshMgr = new SessionManager(paths);
    const list = await freshMgr.listSessions();

    expect(list).toHaveLength(2);
    const ids = list.map((s) => s.session_id);
    expect(ids).toContain('ses_list_a');
    expect(ids).toContain('ses_list_b');
  });

  it('handles sessions with missing state.json gracefully', async () => {
    const mgr = new SessionManager(paths);

    // Create a session dir manually without state.json.
    const sessionDir = paths.sessionDir('ses_no_state');
    await mkdir(sessionDir, { recursive: true });

    const list = await mgr.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0]!.session_id).toBe('ses_no_state');
    expect(list[0]!.created_at).toBe(0);
  });
});

// ── deleteSession ──────────────────────────────────────────────────

describe('SessionManager.deleteSession', () => {
  it('removes session directory from disk', async () => {
    const mgr = new SessionManager(paths);

    await mgr.createSession({
      sessionId: 'ses_del',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test',
    });

    expect(existsSync(paths.sessionDir('ses_del'))).toBe(true);

    await mgr.deleteSession('ses_del');

    expect(existsSync(paths.sessionDir('ses_del'))).toBe(false);
    expect(mgr.get('ses_del')).toBeUndefined();
  });

  it('deletes non-active session from disk only', async () => {
    const mgr = new SessionManager(paths);

    // Create then close (so it's not in the active map).
    await mgr.createSession({
      sessionId: 'ses_cold_del',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test',
    });
    await mgr.closeSession('ses_cold_del');

    // Create session dir manually to simulate cold state.
    expect(existsSync(paths.sessionDir('ses_cold_del'))).toBe(true);

    await mgr.deleteSession('ses_cold_del');
    expect(existsSync(paths.sessionDir('ses_cold_del'))).toBe(false);
  });
});

// ── closeSession ──────────────────────────────────────────────────

describe('SessionManager.closeSession', () => {
  it('flushes state.json and removes from active map', async () => {
    const mgr = new SessionManager(paths);

    await mgr.createSession({
      sessionId: 'ses_close',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test',
    });

    expect(mgr.get('ses_close')).toBeDefined();
    expect(mgr.activeSessionCount).toBe(1);

    await mgr.closeSession('ses_close');

    expect(mgr.get('ses_close')).toBeUndefined();
    expect(mgr.activeSessionCount).toBe(0);

    // state.json should have status = 'closed'.
    const stateRaw = await readFile(paths.statePath('ses_close'), 'utf-8');
    const state = JSON.parse(stateRaw);
    expect(state.status).toBe('closed');
  });

  it('is idempotent for unknown session', async () => {
    const mgr = new SessionManager(paths);
    // Should not throw and should leave active count unchanged.
    await mgr.closeSession('ses_nonexistent');
    expect(mgr.activeSessionCount).toBe(0);
  });
});

// ── End-to-end: create → write → close → resume → verify ──────────

describe('SessionManager end-to-end lifecycle', () => {
  it('full create → close → resume cycle preserves conversation', async () => {
    const mgr = new SessionManager(paths);

    // Create.
    const session = await mgr.createSession({
      sessionId: 'ses_e2e',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'gpt-4',
      systemPrompt: 'You are a helpful assistant.',
    });

    // Write a conversation.
    await session.sessionJournal.appendTurnBegin({
      type: 'turn_begin',
      turn_id: 'turn_1',
      agent_type: 'main',
      user_input: 'What is 2+2?',
      input_kind: 'user',
    });
    await session.contextState.appendUserMessage({ text: 'What is 2+2?' }, 'turn_1');
    await session.contextState.appendAssistantMessage({
      text: '2+2 = 4',
      think: null,
      toolCalls: [],
      model: 'gpt-4',
      usage: { input_tokens: 50, output_tokens: 20 },
    });
    await session.sessionJournal.appendTurnEnd({
      type: 'turn_end',
      turn_id: 'turn_1',
      agent_type: 'main',
      success: true,
      reason: 'done',
    });

    // Close.
    await mgr.closeSession('ses_e2e');

    // Resume with a fresh manager (simulates process restart).
    const freshMgr = new SessionManager(paths);
    const resumed = await freshMgr.resumeSession('ses_e2e', {
      runtime: createNoopRuntime(),
      tools: [],
      model: 'gpt-4',
      systemPrompt: 'You are a helpful assistant.',
    });

    // Verify conversation restored.
    const messages = resumed.contextState.buildMessages();
    const userMsgs = messages.filter((m) => m.role === 'user');
    const assistantMsgs = messages.filter((m) => m.role === 'assistant');

    expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    expect(resumed.contextState.model).toBe('gpt-4');
    expect(resumed.contextState.systemPrompt).toBe('You are a helpful assistant.');
    expect(resumed.contextState.tokenCountWithPending).toBe(70);
  });
});
