/**
 * Phase 23 — JournalWriter force-flush for session_initialized (T8).
 *
 * Contract under test (spec §Step 5.2):
 *   - `FORCE_FLUSH_KINDS` (module export) must include 'session_initialized'.
 *   - Appending a record whose `type === 'session_initialized'` must be
 *     fsynced to disk BEFORE the returned Promise resolves — i.e. the
 *     record is on-disk readable without calling `flush()`.
 *   - This guarantees "SIGKILL-resistant baseline": a crash immediately
 *     after createSession still leaves wire.jsonl with metadata +
 *     session_initialized intact, so resume is possible.
 *
 * Red bar until Phase 23 Step 5.2 lands (FORCE_FLUSH_KINDS gains
 * 'session_initialized').
 *
 * Spec reference:
 *   - phase-23-session-initialized.md §Step 5.2 + §T8
 *   - v2 §4.5.4 (fsync-on-append contract)
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FORCE_FLUSH_KINDS,
  WiredJournalWriter,
  type LifecycleGate,
  type LifecycleState,
} from '../../src/storage/journal-writer.js';
import { replayWire } from '../../src/storage/replay.js';

class StubGate implements LifecycleGate {
  state: LifecycleState = 'active';
}

async function readWireLines(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'kimi-p23-flush-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  vi.useRealTimers();
});

// ── T8.1 — exported constant includes session_initialized ──────────

describe('Phase 23 T8.1 — FORCE_FLUSH_KINDS includes "session_initialized"', () => {
  it('the exported ReadonlySet contains the literal "session_initialized"', () => {
    expect(FORCE_FLUSH_KINDS.has('session_initialized')).toBe(true);
  });

  it('does NOT accidentally drop any of the pre-Phase-23 force-flush kinds', () => {
    // Regression guard: existing recovery-critical kinds must stay.
    expect(FORCE_FLUSH_KINDS.has('approval_response')).toBe(true);
    expect(FORCE_FLUSH_KINDS.has('turn_end')).toBe(true);
    expect(FORCE_FLUSH_KINDS.has('subagent_completed')).toBe(true);
    expect(FORCE_FLUSH_KINDS.has('subagent_failed')).toBe(true);
  });
});

// ── T8.2 — session_initialized is durable on disk before append() resolves ─

describe('Phase 23 T8.2 — append(session_initialized) is fsynced before resolution', () => {
  it('wire.jsonl contains metadata + session_initialized immediately after append() returns (no flush())', async () => {
    // Force an impossibly long drain interval — the only way the record
    // reaches disk before we read is through the force-flush path.
    vi.useFakeTimers();

    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      protocolVersion: '2.1',
      now: () => 1712790000000,
      config: { drainIntervalMs: 10_000_000 }, // effectively never
    });

    await writer.append({
      type: 'session_initialized',
      agent_type: 'main',
      session_id: 'ses_fflush',
      system_prompt: '',
      model: 'm',
      active_tools: [],
      permission_mode: 'default',
      plan_mode: false,
      workspace_dir: '/tmp/ws',
    } as unknown as Parameters<typeof writer.append>[0]);

    // DO NOT call flush() and DO NOT advance fake timers. If the record
    // is on disk, force-flush worked.
    const lines = await readWireLines(filePath);
    expect(lines.length).toBe(2);
    expect(lines[0]!['type']).toBe('metadata');
    expect(lines[1]!['type']).toBe('session_initialized');
    expect(lines[1]!['agent_type']).toBe('main');
    expect(lines[1]!['session_id']).toBe('ses_fflush');
  });

  it('non-force-flush records (e.g. user_message) stay in pending buffer — control case', async () => {
    // Sanity-check counter: the assertion above only proves anything if
    // non-force-flush records WOULD still be pending. This confirms the
    // fake-timers setup is actually suppressing drain.
    vi.useFakeTimers();

    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { drainIntervalMs: 10_000_000 },
    });

    // First write a session_initialized so the metadata header exists
    // (separates force-flush write from the pending-buffer write below).
    await writer.append({
      type: 'session_initialized',
      agent_type: 'main',
      session_id: 'ses_c',
      system_prompt: '',
      model: 'm',
      active_tools: [],
      permission_mode: 'default',
      plan_mode: false,
      workspace_dir: '/tmp/ws',
    } as unknown as Parameters<typeof writer.append>[0]);

    // Then a non-force-flush record — stays in memory, not on disk yet.
    await writer.append({
      type: 'user_message',
      turn_id: 't1',
      content: 'hi',
    });

    // At this moment, the wire should have 2 lines (metadata + session_init),
    // NOT 3 — the user_message is still in pendingRecords.
    const lines = await readWireLines(filePath);
    expect(lines.length).toBe(2);
    expect(writer.pendingRecords.length).toBe(1);
  });
});

// ── T8.3 — SIGKILL-resistant baseline (resume after force-kill) ────

describe('Phase 23 T8.3 — SIGKILL-resistant baseline: replay after crash sees session_initialized', () => {
  it('after writing session_initialized, a hard-abandoned writer still leaves a replayable wire', async () => {
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      protocolVersion: '2.1',
      // use real drain cadence but keep the force-flush as the only durable write
      config: { drainIntervalMs: 10_000 },
    });
    await writer.append({
      type: 'session_initialized',
      agent_type: 'main',
      session_id: 'ses_kill',
      system_prompt: 'sp',
      model: 'm',
      active_tools: [],
      permission_mode: 'default',
      plan_mode: false,
      workspace_dir: '/tmp/ws',
    } as unknown as Parameters<typeof writer.append>[0]);

    // Simulate SIGKILL: we intentionally do NOT call writer.close() or
    // writer.flush(). The file handle is abandoned in the GC. A fresh
    // replay over the same file path must still succeed.
    const result = await replayWire(filePath, { supportedMajor: 2 });
    expect(result.health).toBe('ok');
    expect(result.sessionInitialized.agent_type).toBe('main');
    if (result.sessionInitialized.agent_type === 'main') {
      expect(result.sessionInitialized.session_id).toBe('ses_kill');
    }
    expect(result.sessionInitialized.system_prompt).toBe('sp');
  });

  it('byte-level: wire.jsonl file has non-zero size immediately after session_initialized append', async () => {
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { drainIntervalMs: 10_000_000 },
    });
    await writer.append({
      type: 'session_initialized',
      agent_type: 'main',
      session_id: 'ses_size',
      system_prompt: '',
      model: 'm',
      active_tools: [],
      permission_mode: 'default',
      plan_mode: false,
      workspace_dir: '/tmp/ws',
    } as unknown as Parameters<typeof writer.append>[0]);
    const st = await stat(filePath);
    // At minimum: metadata line + session_initialized line + 2 newlines.
    expect(st.size).toBeGreaterThan(100);
  });
});
