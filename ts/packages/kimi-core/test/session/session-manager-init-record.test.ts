/**
 * Phase 23 — createSession writes session_initialized as wire.jsonl line 2 (T2).
 *
 * Contract under test (spec §Step 5):
 *   - After `createSession` returns, wire.jsonl has ≥2 lines; line 1 is the
 *     metadata header, line 2 is a `session_initialized` record with
 *     `agent_type='main'` and the session's start-config as its payload.
 *   - `session_initialized` is a force-flush record (spec §5.2 + FORCE_FLUSH_KINDS).
 *     Hence the caller does NOT need to call `journalWriter.flush()` before
 *     inspecting wire.jsonl — this distinguishes it from the old "first
 *     append writes metadata on flush" contract.
 *   - Empty / omitted systemPrompt → wire `system_prompt = ''` (explicit default).
 *   - `active_tools` carries tool names only (C1), not schemas.
 *   - `workspace_dir` / `permission_mode` / `plan_mode=false` all thread.
 *
 * Red bar until Phase 23 Step 5 lands (createSession writes session_initialized
 * explicitly between mkdir and ContextState construction).
 *
 * Spec references:
 *   - phase-23-session-initialized.md §Step 5 + §T2
 *   - C1 (tools = name list) + C5 (physical position) + C7 (agent_type='main')
 */

import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PathConfig } from '../../src/session/path-config.js';
import { SessionManager } from '../../src/session/session-manager.js';
import type { Runtime, Tool } from '../../src/soul/index.js';
import { createFakeRuntime } from '../soul/fixtures/fake-runtime.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';

// ── helpers ─────────────────────────────────────────────────────────

function createNoopRuntime(): Runtime {
  const kosong = new ScriptedKosongAdapter({ responses: [] });
  return createFakeRuntime({ kosong }).runtime;
}

function fakeTool(name: string): Tool {
  return {
    name,
    description: `fake ${name}`,
    // Minimal inputSchema — real Tool shape has more fields; cast is OK in
    // tests where we only care about `name`.
    inputSchema: { type: 'object', properties: {} },
  } as unknown as Tool;
}

async function readWireLines(path: string): Promise<unknown[]> {
  const raw = await readFile(path, 'utf-8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

let tmpDir: string;
let paths: PathConfig;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kimi-p23-init-'));
  paths = new PathConfig({ home: tmpDir });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── T2.1 — physical position: line 2 is session_initialized ─────────

describe('Phase 23 T2.1 — createSession writes session_initialized as wire.jsonl line 2', () => {
  it('produces metadata on line 1 and session_initialized on line 2, with matching system_prompt / model / session_id', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_init_a',
      workspaceDir: '/tmp/ws-a',
      runtime: createNoopRuntime(),
      tools: [fakeTool('bash'), fakeTool('read')],
      model: 'moonshot-v1',
      systemPrompt: 'you are helpful',
    });

    // No .flush() here — session_initialized must be force-flushed.
    const records = await readWireLines(paths.wirePath(session.sessionId));
    expect(records.length).toBeGreaterThanOrEqual(2);

    const [meta, init] = records as [Record<string, unknown>, Record<string, unknown>];
    expect(meta['type']).toBe('metadata');
    expect(init['type']).toBe('session_initialized');
    expect(init['agent_type']).toBe('main');
    expect(init['session_id']).toBe('ses_init_a');
    expect(init['system_prompt']).toBe('you are helpful');
    expect(init['model']).toBe('moonshot-v1');
    expect(init['workspace_dir']).toBe('/tmp/ws-a');
    expect(init['plan_mode']).toBe(false);
  });

  it('threads tool names (not schemas) into active_tools (C1 contract)', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_init_tools',
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [fakeTool('bash'), fakeTool('grep'), fakeTool('edit')],
      model: 'm',
    });

    const records = await readWireLines(paths.wirePath(session.sessionId));
    const init = records[1] as Record<string, unknown>;
    expect(init['active_tools']).toEqual(['bash', 'grep', 'edit']);
  });

  it('threads permissionMode into session_initialized', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_init_perm',
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'm',
      permissionMode: 'acceptEdits',
    });

    const records = await readWireLines(paths.wirePath(session.sessionId));
    const init = records[1] as Record<string, unknown>;
    expect(init['permission_mode']).toBe('acceptEdits');
  });
});

// ── T2.2 — force-flush contract ─────────────────────────────────────

describe('Phase 23 T2.2 — session_initialized is force-flushed at createSession time', () => {
  it('wire.jsonl is readable synchronously after createSession returns — no flush() needed', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_fflush',
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'm',
    });

    // Deliberately do NOT flush. FORCE_FLUSH_KINDS must include
    // 'session_initialized', so the record has already been fsynced.
    const records = await readWireLines(paths.wirePath(session.sessionId));
    expect(records[0]).toHaveProperty('type', 'metadata');
    expect(records[1]).toHaveProperty('type', 'session_initialized');
  });
});

// ── T2.3 — empty systemPrompt default ───────────────────────────────

describe('Phase 23 T2.3 — empty system_prompt default', () => {
  it('omitted systemPrompt writes system_prompt = "" (empty string, not missing)', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_no_prompt',
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'm',
      // no systemPrompt
    });

    const records = await readWireLines(paths.wirePath(session.sessionId));
    const init = records[1] as Record<string, unknown>;
    expect(init).toHaveProperty('system_prompt');
    expect(init['system_prompt']).toBe('');
  });

  it('empty-string systemPrompt preserved as "", not coerced to undefined', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_empty_prompt',
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'm',
      systemPrompt: '',
    });

    const records = await readWireLines(paths.wirePath(session.sessionId));
    const init = records[1] as Record<string, unknown>;
    expect(init['system_prompt']).toBe('');
  });
});

// ── T2.4 — default permission_mode ──────────────────────────────────

describe('Phase 23 T2.4 — default permission_mode = "default"', () => {
  it('omitted permissionMode writes permission_mode = "default"', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_def_perm',
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'm',
    });

    const records = await readWireLines(paths.wirePath(session.sessionId));
    const init = records[1] as Record<string, unknown>;
    expect(init['permission_mode']).toBe('default');
  });
});

// ── T2.5 — subsequent records land on line 3+ ──────────────────────

describe('Phase 23 T2.5 — first non-init append lands on line 3', () => {
  it('user-driven appends (turn_begin / messages) append AFTER session_initialized, not before', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_order',
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'm',
      systemPrompt: 'sp',
    });

    await session.sessionJournal.appendTurnBegin({
      type: 'turn_begin',
      turn_id: 'turn_1',
      agent_type: 'main',
      input_kind: 'user',
      user_input: 'hi',
    });
    await session.journalWriter.flush();

    const records = await readWireLines(paths.wirePath(session.sessionId));
    expect(records.length).toBeGreaterThanOrEqual(3);
    expect((records[0] as Record<string, unknown>)['type']).toBe('metadata');
    expect((records[1] as Record<string, unknown>)['type']).toBe('session_initialized');
    expect((records[2] as Record<string, unknown>)['type']).toBe('turn_begin');
  });
});
