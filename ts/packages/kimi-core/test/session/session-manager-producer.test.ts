/**
 * Phase 22 — SessionManager.resumeSession producer error propagation (T3).
 *
 * `resumeSession` currently wraps replay failures as
 *   `Failed to replay session ${sessionId}: ${message}`
 * via `new Error(...)`. Phase 22 must special-case UnsupportedProducerError:
 * let it bubble up *unwrapped* so host UX code (kimi-cli picker / wire
 * protocol router) can `instanceof UnsupportedProducerError` and route into
 * a precise migration prompt instead of a generic "replay failed" string.
 *
 * Other replay errors (WireJournalCorruptError, IncompatibleVersionError,
 * fs ENOENT for a ghost session) still go through the existing wrap.
 *
 * Covered behaviours:
 *   - T3.1  resume a Python-produced wire → throws UnsupportedProducerError
 *           (NOT a generic Error)
 *   - T3.2  resume a legacy (no-producer) wire → throws
 *           UnsupportedProducerError
 *   - T3.3  resume a normal TS wire succeeds
 *   - T3.4  UnsupportedProducerError's .message contains the migration hint
 *   - T3.5  unrelated replay failure (corrupt mid-file) still wrapped as
 *           a generic "Failed to replay session ..." Error
 *
 * Red bar until Step 5 (resumeSession instanceof-bypass branch) lands.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PathConfig } from '../../src/session/path-config.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { UnsupportedProducerError } from '../../src/storage/errors.js';
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
 * Write a wire.jsonl into the session directory with a custom metadata
 * header. Used to simulate wire files created by other producers / older
 * TS versions (legacy) that the current runtime must refuse to resume.
 */
async function seedWire(
  paths: PathConfig,
  sessionId: string,
  metadataObject: Record<string, unknown>,
  bodyLines: Record<string, unknown>[] = [],
): Promise<void> {
  const sessionDir = paths.sessionDir(sessionId);
  await mkdir(sessionDir, { recursive: true });
  const wirePath = paths.wirePath(sessionId);
  const lines = [
    JSON.stringify(metadataObject),
    ...bodyLines.map((r) => JSON.stringify(r)),
  ];
  await writeFile(wirePath, lines.map((l) => l + '\n').join(''), 'utf8');

  // Seed a minimal state.json so the resume path finds its neighbouring
  // metadata (SessionManager reads state.json to pick the exit-code path).
  const statePath = paths.statePath(sessionId);
  await writeFile(
    statePath,
    JSON.stringify({
      session_id: sessionId,
      created_at: Date.now(),
      updated_at: Date.now(),
      last_exit_code: 'clean',
    }),
    'utf8',
  );
}

let tmpDir: string;
let paths: PathConfig;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kimi-sm-producer-'));
  paths = new PathConfig({ home: tmpDir });
  _resetProducerInfoForTest();
});

afterEach(async () => {
  _resetProducerInfoForTest();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('SessionManager.resumeSession — producer propagation (T3)', () => {
  it('resume of a Python-produced wire throws UnsupportedProducerError (instanceof)', async () => {
    await seedWire(paths, 'ses_python', {
      type: 'metadata',
      protocol_version: '2.1',
      created_at: 1_700_000_000_000,
      producer: { kind: 'python', name: 'kimi-cli', version: '1.2.3' },
    });

    const mgr = new SessionManager(paths);
    let caught: unknown;
    try {
      await mgr.resumeSession('ses_python', {
        runtime: createNoopRuntime(),
        tools: [],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsupportedProducerError);
    // Must NOT be the generic wrapped Error from the default catch branch.
    expect((caught as Error).message).not.toMatch(/Failed to replay session/);
  });

  it('resume of a legacy (no-producer) wire throws UnsupportedProducerError (instanceof)', async () => {
    await seedWire(paths, 'ses_legacy', {
      type: 'metadata',
      protocol_version: '2.1',
      created_at: 1_700_000_000_000,
      kimi_version: '0.0.9',
      // no producer field
    });

    const mgr = new SessionManager(paths);
    let caught: unknown;
    try {
      await mgr.resumeSession('ses_legacy', {
        runtime: createNoopRuntime(),
        tools: [],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsupportedProducerError);
    const err = caught as UnsupportedProducerError;
    expect(err.producerKind).toBe('legacy');
    expect(err.reason).toBe('metadata-missing-producer');
  });

  it('resume of a TypeScript-produced wire succeeds', async () => {
    // Go through the real create → close → resume cycle. Needs
    // `setProducerInfo` to be in its default typescript kind so the header
    // passes the hard check on resume.
    setProducerInfo({ version: '0.5.0' });

    const mgr = new SessionManager(paths);
    const created = await mgr.createSession({
      workspaceDir: tmpDir,
      sessionId: 'ses_ts',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
    });
    // Trigger a journal append so wire.jsonl's metadata header lands on disk.
    await created.sessionJournal.appendTurnBegin({
      type: 'turn_begin',
      turn_id: 't1',
      agent_type: 'main',
      user_input: 'hi',
      input_kind: 'user',
    });
    await mgr.closeSession('ses_ts');

    const freshMgr = new SessionManager(paths);
    const resumed = await freshMgr.resumeSession('ses_ts', {
      runtime: createNoopRuntime(),
      tools: [],
    });
    expect(resumed.sessionId).toBe('ses_ts');
  });

  it('UnsupportedProducerError message exposes a migration hint for host UX', async () => {
    await seedWire(paths, 'ses_python_hint', {
      type: 'metadata',
      protocol_version: '2.1',
      created_at: 1_700_000_000_000,
      producer: { kind: 'python', name: 'kimi-cli', version: '1.2.3' },
    });

    const mgr = new SessionManager(paths);
    await expect(
      mgr.resumeSession('ses_python_hint', {
        runtime: createNoopRuntime(),
        tools: [],
      }),
    ).rejects.toThrow(/incompatible/i);
  });

  it('non-producer replay failure (mid-file corruption) still goes through the generic wrap', async () => {
    // Build a TS-producer wire whose 3rd line is garbage. replayWire
    // returns a `broken` health status (not a throw) for mid-file
    // corruption — so this test primarily documents that the producer
    // hard-check does not interfere with the existing broken-health path.
    // Resume should still succeed (no throw) but the replayResult.health
    // flag reflects brokenness. If resumeSession starts throwing on
    // 'broken', adjust this test to match — but it must NEVER throw
    // UnsupportedProducerError for a TS-producer wire.
    const sessionDir = paths.sessionDir('ses_corrupt');
    await mkdir(sessionDir, { recursive: true });
    const wirePath = paths.wirePath('ses_corrupt');
    await writeFile(
      wirePath,
      [
        JSON.stringify({
          type: 'metadata',
          protocol_version: '2.1',
          created_at: 1_700_000_000_000,
          producer: { kind: 'typescript', name: '@moonshot-ai/core', version: '0.1.0' },
        }),
        JSON.stringify({
          type: 'session_initialized',
          seq: 0,
          time: 0,
          agent_type: 'main',
          session_id: 'ses_corrupt',
          system_prompt: '',
          model: 'm',
          active_tools: [],
          permission_mode: 'default',
          plan_mode: false,
          workspace_dir: '/tmp/ws',
        }),
        JSON.stringify({ type: 'user_message', seq: 1, time: 1, turn_id: 't1', content: 'ok' }),
        '{"type":"user_message","se',
        JSON.stringify({
          type: 'user_message',
          seq: 3,
          time: 3,
          turn_id: 't1',
          content: 'after',
        }),
      ]
        .map((l) => l + '\n')
        .join(''),
      'utf8',
    );

    const mgr = new SessionManager(paths);
    let caught: unknown;
    try {
      await mgr.resumeSession('ses_corrupt', {
        runtime: createNoopRuntime(),
        tools: [],
      });
    } catch (err) {
      caught = err;
    }
    // Mid-file corruption is surfaced as `broken` health in ReplayResult;
    // resumeSession does NOT throw on `broken` today, so the happy
    // expectation is no error. The crucial invariant is that whatever
    // leaks out (if this ever changes) must NOT be an
    // UnsupportedProducerError — producer hard-check only fires on missing
    // or non-typescript producer, never on corrupted record bodies.
    expect(caught).toBeUndefined();
    expect(caught).not.toBeInstanceOf(UnsupportedProducerError);
  });
});
