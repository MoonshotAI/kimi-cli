/**
 * Phase 23 — replayWire hard-check for session_initialized (T3).
 *
 * Contract under test (spec §Step 3):
 *   - After parsing metadata + producer (Phase 22), replayWire must read
 *     wire.jsonl line 2 as a `session_initialized` record.
 *       - missing line 2                         → MalformedWireError('session-initialized-missing')
 *       - line 2 is a non-session_initialized    → MalformedWireError('session-initialized-missing')
 *         record (e.g. turn_begin / user_message)  (per spec line 701)
 *       - line 2 fails zod parse                 → MalformedWireError('session-initialized-missing')
 *       - happy path (main wire, valid line 2)   → ReplayResult.sessionInitialized populated
 *         and records[] is sliced from line 3+
 *
 *   - Ordering with existing checks:
 *       empty file / garbage line 1 → WireJournalCorruptError   (unchanged)
 *       protocol_version mismatch    → IncompatibleVersionError (unchanged — Phase 22 priority)
 *       producer mismatch            → UnsupportedProducerError (unchanged — Phase 22 priority)
 *       session_initialized missing  → MalformedWireError        (Phase 23 — new)
 *
 *   - `agent-type-mismatch` is NOT raised by replayWire itself; it is raised
 *     by resumeSession when the caller claims a wire is a main wire but its
 *     session_initialized carries agent_type='sub'. We assert that pairing
 *     separately (see T5 / T6); replayWire alone just returns the record.
 *
 * Red bar until Phase 23 Step 3 lands (replayWire strict line-2 check +
 * MalformedWireError).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  IncompatibleVersionError,
  MalformedWireError,
  UnsupportedProducerError,
  WireJournalCorruptError,
} from '../../src/storage/errors.js';
import { replayWire } from '../../src/storage/replay.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'kimi-replay-malformed-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeWire(lines: string[]): Promise<string> {
  const path = join(workDir, 'wire.jsonl');
  await writeFile(path, lines.map((l) => l + '\n').join(''), 'utf8');
  return path;
}

function metadata(version = '2.1'): string {
  return JSON.stringify({
    type: 'metadata',
    protocol_version: version,
    created_at: 1712790000000,
    kimi_version: '1.0.0',
    producer: { kind: 'typescript', name: '@moonshot-ai/core', version: '1.0.0' },
  });
}

function sessionInitMain(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'session_initialized',
    seq: 1,
    time: 1712790000001,
    agent_type: 'main',
    session_id: 'ses_test',
    system_prompt: '',
    model: 'moonshot-v1',
    active_tools: [],
    permission_mode: 'default',
    plan_mode: false,
    workspace_dir: '/tmp/ws',
    ...overrides,
  });
}

function sessionInitSub(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'session_initialized',
    seq: 1,
    time: 1712790000001,
    agent_type: 'sub',
    agent_id: 'sa_1',
    parent_session_id: 'ses_parent',
    parent_tool_call_id: 'tc_1',
    run_in_background: false,
    system_prompt: '',
    model: 'm',
    active_tools: [],
    permission_mode: 'default',
    plan_mode: false,
    workspace_dir: '/tmp/ws',
    ...overrides,
  });
}

// ── T3.1 — missing session_initialized ──────────────────────────────

describe('replayWire — session_initialized missing (T3.1)', () => {
  it('wire with only metadata line raises MalformedWireError("session-initialized-missing")', async () => {
    const path = await writeWire([metadata('2.1')]);

    let caught: unknown;
    try {
      await replayWire(path, { supportedMajor: 2 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedWireError);
    expect((caught as MalformedWireError).reason).toBe('session-initialized-missing');
  });

  it('line 2 that is NOT a session_initialized record raises MalformedWireError("session-initialized-missing")', async () => {
    // Valid metadata on line 1, but line 2 is a turn_begin — which was the
    // legal pre-Phase-23 shape. Post-Phase-23 contract rejects this.
    const path = await writeWire([
      metadata('2.1'),
      JSON.stringify({
        type: 'turn_begin',
        seq: 1,
        time: 1,
        turn_id: 't1',
        agent_type: 'main',
        input_kind: 'user',
        user_input: 'hi',
      }),
    ]);

    let caught: unknown;
    try {
      await replayWire(path, { supportedMajor: 2 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedWireError);
    expect((caught as MalformedWireError).reason).toBe('session-initialized-missing');
  });

  it('line 2 that fails zod (malformed session_initialized) raises MalformedWireError', async () => {
    const path = await writeWire([
      metadata('2.1'),
      // claims to be session_initialized but missing session_id on main branch
      JSON.stringify({
        type: 'session_initialized',
        seq: 1,
        time: 1,
        agent_type: 'main',
        system_prompt: '',
        model: 'm',
        active_tools: [],
        permission_mode: 'default',
        plan_mode: false,
        workspace_dir: '/tmp/ws',
      }),
    ]);

    let caught: unknown;
    try {
      await replayWire(path, { supportedMajor: 2 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedWireError);
    expect((caught as MalformedWireError).reason).toBe('session-initialized-missing');
  });
});

// ── T3.2 — happy path returns sessionInitialized + sliced records ──

describe('replayWire — session_initialized present (T3.2)', () => {
  it('returns ReplayResult with sessionInitialized populated and records starting from line 3', async () => {
    const path = await writeWire([
      metadata('2.1'),
      sessionInitMain({ system_prompt: 'sp', model: 'm1', session_id: 'ses_x' }),
      JSON.stringify({
        type: 'user_message',
        seq: 2,
        time: 2,
        turn_id: 't1',
        content: 'hi',
      }),
      JSON.stringify({
        type: 'assistant_message',
        seq: 3,
        time: 3,
        turn_id: 't1',
        text: 'hello',
        think: null,
        tool_calls: [],
        model: 'm1',
      }),
    ]);

    const result = await replayWire(path, { supportedMajor: 2 });
    expect(result.health).toBe('ok');
    // session_initialized is extracted to its own field, NOT in records.
    expect(result.records.length).toBe(2);
    expect(result.records.every((r) => r.type !== 'session_initialized')).toBe(true);
    expect(result.sessionInitialized).toBeDefined();
    expect(result.sessionInitialized.agent_type).toBe('main');
    if (result.sessionInitialized.agent_type === 'main') {
      expect(result.sessionInitialized.session_id).toBe('ses_x');
    }
    expect(result.sessionInitialized.system_prompt).toBe('sp');
    expect(result.sessionInitialized.model).toBe('m1');
  });

  it('sub-kind session_initialized is returned as-is (no agent_type mismatch raised at replay layer)', async () => {
    // replayWire just parses. Cross-check vs wire-path expectation
    // (main vs sub) is resumeSession's / subagent-recovery's job.
    const path = await writeWire([metadata('2.1'), sessionInitSub()]);
    const result = await replayWire(path, { supportedMajor: 2 });
    expect(result.sessionInitialized.agent_type).toBe('sub');
  });
});

// ── T3.3 — ordering priority: version > producer > session_initialized ─

describe('replayWire — error ordering priority (T3.3)', () => {
  it('protocol_version incompatibility wins over session_initialized missing', async () => {
    // metadata says future major; no session_initialized. Version error
    // must surface first.
    const path = await writeWire([metadata('3.0')]);

    let caught: unknown;
    try {
      await replayWire(path, { supportedMajor: 2 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IncompatibleVersionError);
    expect(caught).not.toBeInstanceOf(MalformedWireError);
  });

  it('producer mismatch wins over session_initialized missing', async () => {
    const metadataPython = JSON.stringify({
      type: 'metadata',
      protocol_version: '2.1',
      created_at: 1712790000000,
      kimi_version: '1.0.0',
      producer: { kind: 'python', name: 'kimi-cli', version: '1.0.0' },
    });
    const path = await writeWire([metadataPython]);

    let caught: unknown;
    try {
      await replayWire(path, { supportedMajor: 2 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsupportedProducerError);
    expect(caught).not.toBeInstanceOf(MalformedWireError);
  });

  it('metadata corruption still wins — empty wire raises WireJournalCorruptError, not MalformedWireError', async () => {
    const path = join(workDir, 'wire.jsonl');
    await writeFile(path, '', 'utf8');

    let caught: unknown;
    try {
      await replayWire(path, { supportedMajor: 2 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WireJournalCorruptError);
    expect(caught).not.toBeInstanceOf(MalformedWireError);
  });

  it('garbage metadata line wins — raises WireJournalCorruptError, not MalformedWireError', async () => {
    const path = join(workDir, 'wire.jsonl');
    await writeFile(path, '{not-json-at-all\n' + sessionInitMain() + '\n', 'utf8');

    let caught: unknown;
    try {
      await replayWire(path, { supportedMajor: 2 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WireJournalCorruptError);
    expect(caught).not.toBeInstanceOf(MalformedWireError);
  });
});

// ── T3.4 — MalformedWireError shape ─────────────────────────────────

describe('MalformedWireError — shape (T3.4)', () => {
  it('carries reason + detail + a formatted message', async () => {
    const path = await writeWire([metadata('2.1')]);

    let caught: unknown;
    try {
      await replayWire(path, { supportedMajor: 2 });
    } catch (err) {
      caught = err;
    }
    const err = caught as MalformedWireError;
    expect(err).toBeInstanceOf(MalformedWireError);
    expect(err.name).toBe('MalformedWireError');
    expect(err.reason).toBeDefined();
    expect(typeof err.detail).toBe('string');
    expect(err.message).toContain(err.reason);
  });

  it('reason enum covers the three expected values', () => {
    // Type-level assertion: reason is a discriminated literal, not a free string.
    const valid: MalformedWireError['reason'][] = [
      'session-initialized-missing',
      'session-initialized-position-wrong',
      'agent-type-mismatch',
    ];
    expect(valid.length).toBe(3);
  });
});
