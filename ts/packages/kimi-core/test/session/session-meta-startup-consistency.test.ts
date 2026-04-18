/**
 * Phase 16 / T7 — last_exit_code startup consistency.
 *
 * Decision #113 / D7: state.json carries a `last_exit_code` marker
 * ('clean' | 'dirty') written by SessionLifecycle on shutdown.
 *   - createSession writes 'dirty' before the first turn runs — a crash
 *     between createSession and closeSession leaves the marker at 'dirty'.
 *   - closeSession flushes 'clean' as part of its pre-shutdown state.json
 *     write.
 *   - resumeSession (Phase 16 Step 4.4):
 *       • 'clean' → trust state.json's derived fields (fast path).
 *       • 'dirty' / missing → let the replay-projector's sessionMetaPatch
 *         overwrite the state.json derived values (correctness path).
 *
 * Tests don't run full turns — they seed state.json + wire.jsonl by hand so
 * the startup-consistency branch is exercised without a live Soul loop.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PathConfig } from '../../src/session/path-config.js';
import { SessionManager } from '../../src/session/session-manager.js';
import type { SessionState } from '../../src/session/state-cache.js';
import type { Runtime } from '../../src/soul/runtime.js';
import { createFakeRuntime } from '../soul/fixtures/fake-runtime.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';

function createInMemoryRuntime(): Runtime {
  const kosong = new ScriptedKosongAdapter({ responses: [] });
  return createFakeRuntime({ kosong }).runtime;
}

let tmp: string;
let mgr: SessionManager;

async function readState(sessionId: string): Promise<SessionState> {
  const p = join(tmp, 'sessions', sessionId, 'state.json');
  const raw = await readFile(p, 'utf-8');
  return JSON.parse(raw) as SessionState;
}

async function seedSession(
  sessionId: string,
  state: Partial<SessionState> = {},
): Promise<void> {
  const sessionDir = join(tmp, 'sessions', sessionId);
  await mkdir(sessionDir, { recursive: true });
  const statePath = join(sessionDir, 'state.json');
  await writeFile(
    statePath,
    JSON.stringify(
      {
        session_id: sessionId,
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
        ...state,
      },
      null,
      2,
    ),
    'utf-8',
  );
}

async function seedWireWithMeta(
  sessionId: string,
  records: unknown[],
): Promise<void> {
  const wirePath = join(tmp, 'sessions', sessionId, 'wire.jsonl');
  // Wire file always starts with a metadata header.
  const header = JSON.stringify({
    type: 'metadata',
    protocol_version: '2.0.0',
    created_at: 1_700_000_000_000,
    producer: { kind: 'typescript', name: '@moonshot-ai/core', version: '1.0.0' },
  });
  const lines = [header, ...records.map((r) => JSON.stringify(r))].join('\n') + '\n';
  await writeFile(wirePath, lines, 'utf-8');
}

beforeEach(async () => {
  tmp = join(
    tmpdir(),
    `kimi-meta-startup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tmp, { recursive: true });
  mgr = new SessionManager(new PathConfig({ home: tmp }));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('Phase 16 T7 — startup consistency (last_exit_code)', () => {
  it("createSession writes last_exit_code: 'dirty' into the initial state.json", async () => {
    await mgr.createSession({
      runtime: createInMemoryRuntime(),
      tools: [],
      model: 'kimi-k2.5',
      workspaceDir: tmp,
    });
    const state = await readState((await mgr.listSessions())[0]!.session_id);
    expect(state.last_exit_code).toBe('dirty');
  });

  it("closeSession flips last_exit_code to 'clean' and flushes via SessionMetaService", async () => {
    const managed = await mgr.createSession({
      runtime: createInMemoryRuntime(),
      tools: [],
      model: 'kimi-k2.5',
      workspaceDir: tmp,
    });
    await mgr.closeSession(managed.sessionId);
    const state = await readState(managed.sessionId);
    expect(state.last_exit_code).toBe('clean');
  });

  it("resume after a clean exit trusts state.json: custom_title survives without re-replay", async () => {
    const sessionId = 'ses_clean';
    await seedSession(sessionId, {
      custom_title: 'trusted',
      tags: ['kept'],
      model: 'kimi-k2.5',
      last_exit_code: 'clean',
    });
    // Minimal wire so resume can replay without errors. No meta records —
    // the test intent is that state.json's 'trusted' survives.
    await seedWireWithMeta(sessionId, []);

    const managed = await mgr.resumeSession(sessionId, {
      runtime: createInMemoryRuntime(),
      tools: [],
      model: 'kimi-k2.5',
    });

    // SessionMetaService.get() must reflect the trusted state.json values.
    const meta = managed.soulPlus.getSessionMeta().get();
    expect(meta.title).toBe('trusted');
    expect(meta.tags).toEqual(['kept']);
  });

  it("resume after a dirty exit lets replayed meta overwrite state.json-derived fields", async () => {
    const sessionId = 'ses_dirty';
    // state.json still says "stale"; wire is the truth.
    await seedSession(sessionId, {
      custom_title: 'stale-title',
      last_exit_code: 'dirty',
    });
    await seedWireWithMeta(sessionId, [
      {
        type: 'session_meta_changed',
        seq: 1,
        time: 1,
        patch: { title: 'wire-truth' },
        source: 'user',
      },
    ]);

    const managed = await mgr.resumeSession(sessionId, {
      runtime: createInMemoryRuntime(),
      tools: [],
      model: 'kimi-k2.5',
    });

    const meta = managed.soulPlus.getSessionMeta().get();
    expect(meta.title).toBe('wire-truth');
  });

  it("dirty resume also recovers turn_count and last_model from wire", async () => {
    const sessionId = 'ses_dirty_derived';
    await seedSession(sessionId, { last_exit_code: 'dirty', model: 'outdated' });
    await seedWireWithMeta(sessionId, [
      {
        type: 'turn_begin',
        seq: 1,
        time: 1,
        turn_id: 'turn_1',
        agent_type: 'main',
        input_kind: 'user',
      },
      {
        type: 'turn_begin',
        seq: 2,
        time: 2,
        turn_id: 'turn_2',
        agent_type: 'main',
        input_kind: 'user',
      },
      {
        type: 'model_changed',
        seq: 3,
        time: 3,
        old_model: 'outdated',
        new_model: 'kimi-k2.5',
      },
    ]);

    const managed = await mgr.resumeSession(sessionId, {
      runtime: createInMemoryRuntime(),
      tools: [],
      model: 'outdated',
    });

    const meta = managed.soulPlus.getSessionMeta().get();
    expect(meta.turn_count).toBe(2);
    expect(meta.last_model).toBe('kimi-k2.5');
  });

  it("missing last_exit_code is treated as dirty (conservative default)", async () => {
    const sessionId = 'ses_no_marker';
    // state.json with no last_exit_code at all — legacy sessions or first run.
    await seedSession(sessionId, { custom_title: 'legacy' });
    await seedWireWithMeta(sessionId, [
      {
        type: 'session_meta_changed',
        seq: 1,
        time: 1,
        patch: { title: 'from-wire' },
        source: 'user',
      },
    ]);

    const managed = await mgr.resumeSession(sessionId, {
      runtime: createInMemoryRuntime(),
      tools: [],
      model: 'kimi-k2.5',
    });

    const meta = managed.soulPlus.getSessionMeta().get();
    // Replay wins because "no marker" must be treated as dirty.
    expect(meta.title).toBe('from-wire');
  });
});
