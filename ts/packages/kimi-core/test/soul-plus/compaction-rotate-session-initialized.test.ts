/**
 * Phase 23 — compaction rotate copies session_initialized (T7).
 *
 * Rotate order contract (spec §Step 8 + C6):
 *   BEFORE rotate (old wire.jsonl):
 *     line 1: metadata
 *     line 2: session_initialized
 *     line 3..N: body records
 *
 *   AFTER rotate (new wire.jsonl):
 *     line 1: metadata            ← freshly written by JournalWriter.ensureMetadataInit
 *     line 2: session_initialized ← COPIED from old wire (same content)
 *     line 3: compaction          ← boundary record
 *     line 4..N: post-compact records
 *
 *   OLD wire is archived as wire.N.jsonl (N = 1-based rotation count).
 *
 * Test scope:
 *   T7.1 rotate-order contract (integration via CompactionOrchestrator +
 *        a real on-disk WiredJournalWriter + JournalCapability)
 *   T7.2 JournalCapability interface surface (readSessionInitialized + appendBoundary)
 *   T7.3 copied session_initialized preserves every baseline field (system_prompt,
 *        model, permission_mode, active_tools, workspace_dir)
 *   T7.4 resume through the post-rotate wire reconstructs ContextState from
 *        the copied session_initialized baseline
 *   T7.5 re-rotate (compact twice) preserves session_initialized in each
 *        new wire
 *   T7.6 half-done rotate (crash after rotate but BEFORE appendBoundary)
 *        is recovered by recoverRotation without losing session_initialized
 *
 * Red bar until Phase 23 Step 8 lands (readSessionInitialized +
 * appendBoundary on JournalCapability + orchestrator wiring).
 *
 * Spec references:
 *   - phase-23-session-initialized.md §Step 8 + §T7
 *   - C6 (rotate copies session_initialized — order: metadata → session_init → compaction)
 *   - v2 §4.1.2 (wire.jsonl physical row contract post-compaction)
 */

import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PathConfig } from '../../src/session/path-config.js';
import { SessionManager } from '../../src/session/session-manager.js';
import type { Runtime } from '../../src/soul/runtime.js';
import { createFakeRuntime } from '../soul/fixtures/fake-runtime.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';
import type {
  CompactionProvider,
  JournalCapability,
  SummaryMessage,
} from '../../src/soul/index.js';

// ── helpers ─────────────────────────────────────────────────────────

function createNoopRuntime(): Runtime {
  const kosong = new ScriptedKosongAdapter({ responses: [] });
  return createFakeRuntime({ kosong }).runtime;
}

function summaryProvider(content: string): CompactionProvider {
  return {
    async run(): Promise<SummaryMessage> {
      return {
        content,
        original_turn_count: 1,
        original_token_count: 100,
      };
    },
  };
}

async function readWireLines(path: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path, 'utf-8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

let tmpDir: string;
let paths: PathConfig;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kimi-p23-rotate-'));
  paths = new PathConfig({ home: tmpDir });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── T7.1 — rotate contract order ────────────────────────────────────

describe('Phase 23 T7.1 — rotate emits new wire in order: metadata → session_initialized → compaction', () => {
  it('after compact, new wire.jsonl carries a copied session_initialized between metadata and compaction', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_rotate_order',
      workspaceDir: '/tmp/ws-r',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'baseline-model',
      systemPrompt: 'baseline-prompt',
      compactionProvider: summaryProvider('SUMMARY-AFTER-ROTATE'),
    });

    // Write a few turns so there's something to compact.
    await session.contextState.appendUserMessage({ text: 'q1' }, 'turn_1');
    await session.contextState.appendAssistantMessage({
      text: 'a1',
      think: null,
      toolCalls: [],
      model: 'baseline-model',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    // Trigger compaction via TurnManager (real rotate path).
    const turnMgr = session.soulPlus.getTurnManager();
    await turnMgr.triggerCompaction('manual');

    await session.journalWriter.flush();

    const newWire = await readWireLines(paths.wirePath('ses_rotate_order'));
    expect(newWire.length).toBeGreaterThanOrEqual(3);
    expect(newWire[0]!['type']).toBe('metadata');
    expect(newWire[1]!['type']).toBe('session_initialized');
    expect(newWire[2]!['type']).toBe('compaction');
  });

  it('old wire is preserved at wire.1.jsonl after rotate', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_rotate_archive',
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'm',
      compactionProvider: summaryProvider('S'),
    });
    await session.contextState.appendUserMessage({ text: 'q' }, 't1');
    await session.soulPlus.getTurnManager().triggerCompaction('manual');

    const dir = paths.sessionDir('ses_rotate_archive');
    const entries = await readdir(dir);
    expect(entries).toContain('wire.jsonl');
    expect(entries.some((e) => /^wire\.\d+\.jsonl$/.test(e))).toBe(true);
  });
});

// ── T7.2 — JournalCapability interface ─────────────────────────────

describe('Phase 23 T7.2 — JournalCapability surface includes readSessionInitialized + appendBoundary', () => {
  it('JournalCapability TS type exposes both new methods (compile-time contract)', () => {
    // Compile-time assertion: a structural type with just the new methods
    // must be assignable to JournalCapability (after the interface is
    // extended by the Implementer).
    const probe: Pick<JournalCapability, 'readSessionInitialized' | 'appendBoundary'> = {
      async readSessionInitialized() {
        throw new Error('not reached');
      },
      async appendBoundary() {
        throw new Error('not reached');
      },
    };
    expect(typeof probe.readSessionInitialized).toBe('function');
    expect(typeof probe.appendBoundary).toBe('function');
  });
});

// ── T7.3 — every baseline field copied verbatim ────────────────────

describe('Phase 23 T7.3 — copied session_initialized preserves baseline fields', () => {
  it('system_prompt / model / permission_mode / active_tools / workspace_dir / session_id all mirror the original', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_copy_fidelity',
      workspaceDir: '/tmp/baseline-ws',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'baseline-model',
      systemPrompt: 'baseline-prompt',
      permissionMode: 'acceptEdits',
      compactionProvider: summaryProvider('S'),
    });
    // Capture original session_initialized from line 2 of the fresh wire.
    const preLines = await readWireLines(paths.wirePath('ses_copy_fidelity'));
    const originalInit = preLines[1]!;
    expect(originalInit['type']).toBe('session_initialized');

    // Run one turn → triggerCompaction.
    await session.contextState.appendUserMessage({ text: 'q' }, 't');
    await session.soulPlus.getTurnManager().triggerCompaction('manual');
    await session.journalWriter.flush();

    const postLines = await readWireLines(paths.wirePath('ses_copy_fidelity'));
    const copiedInit = postLines[1]!;

    // Field-by-field equality. The copied record is BIT-identical to the
    // original except possibly seq / time (re-stamped by the writer).
    expect(copiedInit['type']).toBe('session_initialized');
    expect(copiedInit['agent_type']).toBe(originalInit['agent_type']);
    expect(copiedInit['session_id']).toBe(originalInit['session_id']);
    expect(copiedInit['system_prompt']).toBe(originalInit['system_prompt']);
    expect(copiedInit['model']).toBe(originalInit['model']);
    expect(copiedInit['permission_mode']).toBe(originalInit['permission_mode']);
    expect(copiedInit['workspace_dir']).toBe(originalInit['workspace_dir']);
    expect(copiedInit['active_tools']).toEqual(originalInit['active_tools']);
    expect(copiedInit['plan_mode']).toBe(originalInit['plan_mode']);
  });
});

// ── T7.4 — resume after compaction still reconstructs baseline ─────

describe('Phase 23 T7.4 — resume after rotate reconstructs baseline from the copied session_initialized', () => {
  it('close → resume after compact → ContextState.systemPrompt / model match the pre-compact baseline', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_resume_post_rotate',
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'rotate-model',
      systemPrompt: 'rotate-prompt',
      compactionProvider: summaryProvider('post-compact summary'),
    });
    await session.contextState.appendUserMessage({ text: 'q' }, 't1');
    await session.soulPlus.getTurnManager().triggerCompaction('manual');
    await mgr.closeSession('ses_resume_post_rotate');

    const freshMgr = new SessionManager(paths);
    const resumed = await freshMgr.resumeSession('ses_resume_post_rotate', {
      runtime: createNoopRuntime(),
      tools: [],
      // no model / systemPrompt fallback — wire is the truth source
    });

    expect(resumed.contextState.systemPrompt).toBe('rotate-prompt');
    expect(resumed.contextState.model).toBe('rotate-model');
  });
});

// ── T7.5 — re-rotate preserves session_initialized in every new wire ─

describe('Phase 23 T7.5 — compact twice (re-rotate) still preserves session_initialized', () => {
  it('second compaction produces another wire with metadata → session_initialized → compaction', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_double_rotate',
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'm',
      systemPrompt: 'sp',
      compactionProvider: summaryProvider('S'),
    });

    await session.contextState.appendUserMessage({ text: 'q1' }, 't1');
    await session.soulPlus.getTurnManager().triggerCompaction('manual');

    // second /compact — new post-rotate records first, then compact again
    await session.contextState.appendUserMessage({ text: 'q2' }, 't2');
    await session.soulPlus.getTurnManager().triggerCompaction('manual');
    await session.journalWriter.flush();

    const lines = await readWireLines(paths.wirePath('ses_double_rotate'));
    expect(lines[0]!['type']).toBe('metadata');
    expect(lines[1]!['type']).toBe('session_initialized');
    expect(lines[2]!['type']).toBe('compaction');

    // Two archive files expected after two rotations.
    const entries = await readdir(paths.sessionDir('ses_double_rotate'));
    const archives = entries.filter((e) => /^wire\.\d+\.jsonl$/.test(e));
    expect(archives.length).toBeGreaterThanOrEqual(2);
  });
});

// ── T7.6 — recoverRotation preserves session_initialized ───────────

describe('Phase 23 T7.6 — half-done rotate: recoverRotation rolls back without losing session_initialized', () => {
  it('wire.jsonl containing only metadata (no session_initialized yet) + an archive → recoverRotation restores archive', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_half_rotate',
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'half-model',
      systemPrompt: 'half-prompt',
    });
    await session.contextState.appendUserMessage({ text: 'q' }, 't1');
    await mgr.closeSession('ses_half_rotate');

    const sessionDir = paths.sessionDir('ses_half_rotate');
    const wirePath = paths.wirePath('ses_half_rotate');
    const archivePath = join(sessionDir, 'wire.1.jsonl');

    // Simulate: rotate() executed (rename old → archive, new wire written
    // with metadata header) but we crashed BEFORE appendBoundary copied
    // session_initialized into the new wire.
    await rename(wirePath, archivePath);
    await writeFile(
      wirePath,
      JSON.stringify({
        type: 'metadata',
        protocol_version: '2.1',
        created_at: Date.now(),
        producer: { kind: 'typescript', name: '@moonshot-ai/core', version: '0.1.0' },
      }) + '\n',
      'utf8',
    );

    // Resume: recoverRotation must detect the metadata-only wire.jsonl,
    // restore wire.1.jsonl as wire.jsonl, and replay succeeds.
    const freshMgr = new SessionManager(paths);
    const resumed = await freshMgr.resumeSession('ses_half_rotate', {
      runtime: createNoopRuntime(),
      tools: [],
    });
    expect(resumed.contextState.systemPrompt).toBe('half-prompt');
    expect(resumed.contextState.model).toBe('half-model');
  });
});
