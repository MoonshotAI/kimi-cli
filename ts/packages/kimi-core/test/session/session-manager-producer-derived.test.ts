/**
 * Phase 22 — producer as derived field on state.json / SessionInfo /
 * SessionMeta (T4).
 *
 * Producer lands in wire.jsonl as the truth source (Step 3). It is then
 * projected through:
 *   - SessionMeta.producer (in-memory)
 *   - state.json `producer` (on-disk derived cache, flushed by SessionMetaService)
 *   - SessionInfo.producer (surfaced via listSessions)
 *
 * Invariants under test:
 *   T4.1  createSession → state.json contains `producer` after the meta
 *         flush debounce window drains
 *   T4.2  listSessions() returns SessionInfo[] each carrying producer
 *   T4.3  resumeSession → SoulPlus.getSessionMeta().get().producer ===
 *         wire metadata.producer
 *   T4.4  legacy state.json without `producer` → SessionInfo.producer is
 *         undefined (tolerant read path)
 *   T4.5  setProducerInfo({ version: '0.9.0' }) before createSession →
 *         new state.json's producer.version === '0.9.0'
 *
 * Red bar until Steps 3–6 land.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PathConfig } from '../../src/session/path-config.js';
import { SessionManager } from '../../src/session/session-manager.js';
import {
  _resetProducerInfoForTest,
  setProducerInfo,
} from '../../src/storage/producer-info.js';
import type { Runtime } from '../../src/soul/runtime.js';
import { createFakeRuntime } from '../soul/fixtures/fake-runtime.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';

function createNoopRuntime(): Runtime {
  const kosong = new ScriptedKosongAdapter({ responses: [] });
  return createFakeRuntime({ kosong }).runtime;
}

/**
 * Poll until a predicate returns true or `timeoutMs` elapses. Small helper
 * for Phase 16 debounced state.json flushes — the service's default
 * `flushDebounceMs` is 200ms so we give it a conservative upper bound.
 */
async function waitFor<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs = 2000,
): Promise<T> {
  const start = Date.now();
  let last: T;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    last = await read();
    if (ok(last)) return last;
    if (Date.now() - start > timeoutMs) return last;
    await new Promise((r) => setTimeout(r, 20));
  }
}

let tmpDir: string;
let paths: PathConfig;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kimi-sm-producer-derived-'));
  paths = new PathConfig({ home: tmpDir });
  _resetProducerInfoForTest();
});

afterEach(async () => {
  _resetProducerInfoForTest();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('SessionManager — state.json carries derived producer (T4.1)', () => {
  it('createSession + meta flush → state.json contains producer field', async () => {
    setProducerInfo({ version: '0.5.0' });

    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      workspaceDir: tmpDir,
      sessionId: 'ses_producer_a',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
    });
    // Trigger the SessionMetaService flush path. A trivial setTitle goes
    // through the wire + debounced flush.
    await session.soulPlus.getSessionMeta().setTitle('kickoff', 'system');
    // The debounce lands within 200ms; poll.
    const state = await waitFor(
      async () => {
        try {
          const raw = await readFile(paths.statePath('ses_producer_a'), 'utf-8');
          return JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return {} as Record<string, unknown>;
        }
      },
      (s) => s['producer'] !== undefined,
    );
    expect(state['producer']).toBeDefined();
    const producer = state['producer'] as Record<string, unknown>;
    expect(producer['kind']).toBe('typescript');
    expect(producer['version']).toBe('0.5.0');
  });
});

describe('SessionManager.listSessions — SessionInfo.producer (T4.2)', () => {
  it('listSessions surfaces producer per entry', async () => {
    setProducerInfo({ version: '0.5.0' });

    const mgr = new SessionManager(paths);
    const a = await mgr.createSession({
      workspaceDir: tmpDir,
      sessionId: 'ses_list_a',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'm',
    });
    await a.soulPlus.getSessionMeta().setTitle('a', 'system');
    await a.soulPlus.getSessionMeta().flushPending();
    await mgr.closeSession('ses_list_a');

    setProducerInfo({ version: '0.6.0' });
    const b = await mgr.createSession({
      workspaceDir: tmpDir,
      sessionId: 'ses_list_b',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'm',
    });
    await b.soulPlus.getSessionMeta().setTitle('b', 'system');
    await b.soulPlus.getSessionMeta().flushPending();
    await mgr.closeSession('ses_list_b');

    const freshMgr = new SessionManager(paths);
    const infos = await freshMgr.listSessions();
    const byId = new Map(infos.map((i) => [i.session_id, i]));
    expect(byId.get('ses_list_a')?.producer).toBeDefined();
    expect(byId.get('ses_list_a')?.producer?.kind).toBe('typescript');
    expect(byId.get('ses_list_a')?.producer?.version).toBe('0.5.0');
    expect(byId.get('ses_list_b')?.producer?.version).toBe('0.6.0');
  });
});

describe('SessionManager.resumeSession — SessionMeta.producer wire round-trip (T4.3)', () => {
  it('resumed SessionMeta.producer mirrors the wire metadata producer', async () => {
    setProducerInfo({ version: '0.7.0' });

    const mgr = new SessionManager(paths);
    const created = await mgr.createSession({
      workspaceDir: tmpDir,
      sessionId: 'ses_rt',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
    });
    // Force the wire header to land.
    await created.sessionJournal.appendTurnBegin({
      type: 'turn_begin',
      turn_id: 't1',
      agent_type: 'main',
      user_input: 'hi',
      input_kind: 'user',
    });
    await mgr.closeSession('ses_rt');

    // Fresh manager → resume path. The producer stamped onto the wire on
    // create must be the one the resumed session observes.
    const freshMgr = new SessionManager(paths);
    const resumed = await freshMgr.resumeSession('ses_rt', {
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
    });
    const meta = resumed.soulPlus.getSessionMeta().get();
    expect(meta.producer).toBeDefined();
    expect(meta.producer?.kind).toBe('typescript');
    expect(meta.producer?.name).toBe('@moonshot-ai/core');
    expect(meta.producer?.version).toBe('0.7.0');
  });
});

describe('SessionManager — legacy state.json without producer (T4.4)', () => {
  it('SessionInfo.producer is undefined when state.json predates Phase 22', async () => {
    const sessionId = 'ses_legacy_state';
    const sessionDir = paths.sessionDir(sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      paths.statePath(sessionId),
      JSON.stringify({
        session_id: sessionId,
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
        model: 'test-model',
        status: 'active',
        last_exit_code: 'clean',
        // no `producer` field — simulates a state.json written by a
        // pre-Phase-22 build.
      }),
      'utf-8',
    );

    const mgr = new SessionManager(paths);
    const infos = await mgr.listSessions();
    const info = infos.find((i) => i.session_id === sessionId);
    expect(info).toBeDefined();
    expect(info!.producer).toBeUndefined();
  });
});

describe('SessionManager — setProducerInfo.version flows into new state.json (T4.5)', () => {
  it('state.json\'s producer.version matches setProducerInfo value at create time', async () => {
    setProducerInfo({ version: '0.9.0' });
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      workspaceDir: tmpDir,
      sessionId: 'ses_version_flow',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
    });
    await session.soulPlus.getSessionMeta().setTitle('t', 'system');
    await session.soulPlus.getSessionMeta().flushPending();

    const state = JSON.parse(
      await readFile(paths.statePath('ses_version_flow'), 'utf-8'),
    ) as Record<string, unknown>;
    const producer = state['producer'] as Record<string, unknown> | undefined;
    expect(producer).toBeDefined();
    expect(producer!['version']).toBe('0.9.0');
  });
});
