/**
 * Slice 3.3 — Storage-layer compaction regression tests.
 *
 * Covers:
 *   - M04: recoverRotation handles metadata-only wire.jsonl (half-complete rotation)
 *   - M04: resetToSummary writes archive_file on CompactionRecord
 *   - WiredJournalWriter.resetForRotation seq reset
 *   - End-to-end: rotate → resetToSummary → replay → verify
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionLifecycleStateMachine } from '../../src/soul-plus/lifecycle-state-machine.js';
import { recoverRotation, replayWireSession, rotateJournal } from '../../src/storage/compaction.js';
import { InMemoryContextState, type SummaryMessage } from '../../src/storage/context-state.js';
import { WiredJournalWriter } from '../../src/storage/journal-writer.js';
import { replayWire } from '../../src/storage/replay.js';

// ── M04: recoverRotation — metadata-only detection ──────────────────

describe('recoverRotation — metadata-only half-complete detection (M04)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kimi-recovery-m04-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('detects metadata-only wire.jsonl with archives → rolls back', async () => {
    // Simulate half-complete rotation:
    // 1. wire.jsonl was renamed to wire.1.jsonl (archive)
    // 2. New wire.jsonl was created with metadata header
    // 3. Process crashed before compaction record was written

    const archiveContent =
      '{"type":"metadata","protocol_version":"2.1","created_at":900,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}\n' +
      '{"type":"user_message","seq":1,"time":901,"turn_id":"t1","content":"important data"}\n';
    await writeFile(join(workDir, 'wire.1.jsonl'), archiveContent, 'utf8');

    // Metadata-only new file (half-complete)
    await writeFile(
      join(workDir, 'wire.jsonl'),
      '{"type":"metadata","protocol_version":"2.1","created_at":1000,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}\n',
      'utf8',
    );

    const recovered = await recoverRotation(workDir);

    expect(recovered).toBe(true);
    // wire.jsonl should now contain the archive content (rolled back)
    const content = await readFile(join(workDir, 'wire.jsonl'), 'utf8');
    expect(content).toBe(archiveContent);
  });

  it('does NOT recover when wire.jsonl has records beyond metadata', async () => {
    // wire.jsonl has metadata + compaction record = completed rotation
    const archiveContent =
      '{"type":"metadata","protocol_version":"2.1","created_at":900,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}\n' +
      '{"type":"user_message","seq":1,"time":901,"turn_id":"t1","content":"old data"}\n';
    await writeFile(join(workDir, 'wire.1.jsonl'), archiveContent, 'utf8');

    const currentContent =
      '{"type":"metadata","protocol_version":"2.1","created_at":1000,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}\n' +
      '{"type":"compaction","seq":1,"time":1001,"summary":"compacted","compacted_range":{"from_turn":1,"to_turn":1,"message_count":1},"pre_compact_tokens":100,"post_compact_tokens":20,"trigger":"auto"}\n';
    await writeFile(join(workDir, 'wire.jsonl'), currentContent, 'utf8');

    const recovered = await recoverRotation(workDir);
    expect(recovered).toBe(false);
  });

  it('does NOT recover metadata-only wire.jsonl when no archives exist', async () => {
    // A fresh session that just has metadata but no archives — not a rotation
    await writeFile(
      join(workDir, 'wire.jsonl'),
      '{"type":"metadata","protocol_version":"2.1","created_at":1000,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}\n',
      'utf8',
    );

    const recovered = await recoverRotation(workDir);
    expect(recovered).toBe(false);
  });

  it('rolls back highest archive in multi-archive half-complete scenario', async () => {
    // wire.1.jsonl = oldest archive, wire.2.jsonl = just rotated, wire.jsonl = metadata-only
    await writeFile(join(workDir, 'wire.1.jsonl'), 'oldest archive\n', 'utf8');

    const latestArchive =
      '{"type":"metadata","protocol_version":"2.1","created_at":900,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}\n' +
      '{"type":"user_message","seq":1,"time":901,"turn_id":"t2","content":"recent data"}\n';
    await writeFile(join(workDir, 'wire.2.jsonl'), latestArchive, 'utf8');

    await writeFile(
      join(workDir, 'wire.jsonl'),
      '{"type":"metadata","protocol_version":"2.1","created_at":1000,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}\n',
      'utf8',
    );

    const recovered = await recoverRotation(workDir);

    expect(recovered).toBe(true);
    const content = await readFile(join(workDir, 'wire.jsonl'), 'utf8');
    expect(content).toBe(latestArchive);
  });

  it('still handles wire.jsonl-missing case (original scenario)', async () => {
    const archiveContent =
      '{"type":"metadata","protocol_version":"2.1","created_at":900,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}\n' +
      '{"type":"user_message","seq":1,"time":901,"turn_id":"t1","content":"hello"}\n';
    await writeFile(join(workDir, 'wire.1.jsonl'), archiveContent, 'utf8');
    // wire.jsonl does NOT exist

    const recovered = await recoverRotation(workDir);
    expect(recovered).toBe(true);
    const content = await readFile(join(workDir, 'wire.jsonl'), 'utf8');
    expect(content).toBe(archiveContent);
  });
});

// ── M04: resetToSummary writes archive_file ──────────────────────────

describe('resetToSummary — archive_file field (M04)', () => {
  it('InMemoryContextState.resetToSummary records archive_file in SummaryMessage', async () => {
    const ctx = new InMemoryContextState({ initialModel: 'test-model' });
    await ctx.appendUserMessage({ text: 'hello' });

    const summary: SummaryMessage = {
      summary: 'Compacted summary.',
      compactedRange: { fromTurn: 1, toTurn: 1, messageCount: 1 },
      preCompactTokens: 100,
      postCompactTokens: 20,
      trigger: 'auto',
      archiveFile: 'wire.1.jsonl',
    };
    await ctx.resetToSummary(summary);

    // After reset, tokenCountWithPending should reflect the post-compact value
    expect(ctx.tokenCountWithPending).toBe(20);
    // And buildMessages should show the summary
    const messages = ctx.buildMessages();
    expect(messages.length).toBe(1);
    expect(messages[0]!.role).toBe('assistant');
  });
});

// ── WiredJournalWriter.resetForRotation ──────────────────────────────

describe('WiredJournalWriter.resetForRotation — seq reset (M04)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kimi-writer-reset-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('after resetForRotation, next append gets seq=1', async () => {
    const lifecycle = new SessionLifecycleStateMachine('active');
    const filePath = join(workDir, 'wire.jsonl');

    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: {
        get state() {
          return lifecycle.state === 'active' ? ('active' as const) : ('active' as const);
        },
      },
      // Phase 3: pin per-record mode so the "append → read file back"
      // assertions don't need explicit flush() calls.
      config: { fsyncMode: 'per-record' },
    });

    // Write some records to advance seq
    await writer.append({ type: 'user_message', turn_id: 't1', content: 'hello' });
    await writer.append({ type: 'user_message', turn_id: 't1', content: 'world' });

    // Simulate rotation: the file at `filePath` is replaced
    // In real code, rotateJournal renames the old file and creates a new one
    await writeFile(
      filePath,
      '{"type":"metadata","protocol_version":"2.1","created_at":2000,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}\n',
      'utf8',
    );

    // Reset the writer
    writer.resetForRotation();

    // Next append should get seq=1
    const record = await writer.append({
      type: 'compaction',
      summary: 'compacted',
      compacted_range: { from_turn: 1, to_turn: 2, message_count: 2 },
      pre_compact_tokens: 100,
      post_compact_tokens: 20,
      trigger: 'auto',
    });

    expect(record.seq).toBe(1);

    // Verify the file is valid — read it back
    const content = await readFile(filePath, 'utf8');
    const lines = content.trim().split('\n');
    // Should have: metadata (from writeFile above) + compaction record
    expect(lines.length).toBe(2);
    const compactionLine = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(compactionLine['type']).toBe('compaction');
    expect(compactionLine['seq']).toBe(1);
  });
});

// ── End-to-end: rotate → resetToSummary → replay ────────────────────

describe('End-to-end: compaction rotation + replay', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kimi-e2e-compaction-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('full rotation cycle: wire.jsonl rotated, compaction record written, both files replay healthy', async () => {
    // Step 1: Create a wire.jsonl with some conversation
    const originalContent =
      '{"type":"metadata","protocol_version":"2.1","created_at":1000,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}\n' +
      '{"type":"user_message","seq":1,"time":1001,"turn_id":"t1","content":"hello"}\n' +
      '{"type":"assistant_message","seq":2,"time":1002,"turn_id":"t1","text":"hi","think":null,"tool_calls":[],"model":"m","usage":{"input_tokens":10,"output_tokens":5}}\n' +
      '{"type":"user_message","seq":3,"time":1003,"turn_id":"t2","content":"how are you?"}\n';
    const filePath = join(workDir, 'wire.jsonl');
    await writeFile(filePath, originalContent, 'utf8');

    // Step 2: Rotate
    const rotateResult = await rotateJournal(workDir);
    expect(rotateResult.archivePath).toContain('wire.1.jsonl');

    // Step 3: Create a JournalWriter pointing at the new wire.jsonl
    // and write a compaction record
    const lifecycle = new SessionLifecycleStateMachine('active');
    // Transition to compacting for the compaction record write
    lifecycle.transitionTo('compacting');

    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: {
        get state() {
          const s = lifecycle.state;
          if (s === 'active' || s === 'compacting' || s === 'completing') return s;
          return 'active' as const;
        },
      },
      // After rotation, start fresh
      initialSeq: 0,
      metadataAlreadyWritten: true,
      // Phase 3: pin per-record mode so replay reads see records the
      // moment `append` resolves.
      config: { fsyncMode: 'per-record' },
    });

    const compactionRecord = await writer.append({
      type: 'compaction',
      summary: 'User greeted assistant, assistant responded.',
      compacted_range: { from_turn: 1, to_turn: 2, message_count: 3 },
      pre_compact_tokens: 100,
      post_compact_tokens: 20,
      trigger: 'auto',
      archive_file: 'wire.1.jsonl',
    });
    expect(compactionRecord.seq).toBe(1);

    // Step 4: Replay both files
    const archiveReplay = await replayWire(join(workDir, 'wire.1.jsonl'), { supportedMajor: 2 });
    expect(archiveReplay.health).toBe('ok');
    expect(archiveReplay.records.length).toBe(3); // 3 data records

    const currentReplay = await replayWire(join(workDir, 'wire.jsonl'), { supportedMajor: 2 });
    expect(currentReplay.health).toBe('ok');
    expect(currentReplay.records.length).toBe(1); // compaction record
    expect(currentReplay.records[0]!.type).toBe('compaction');

    // Step 5: Full session replay
    const sessionReplay = await replayWireSession(workDir, { supportedMajor: 2 });
    expect(sessionReplay.health).toBe('ok');
    expect(sessionReplay.records.length).toBe(4); // 3 from archive + 1 compaction

    // Step 6: Verify the compaction record has archive_file
    const compactionRecords = sessionReplay.records.filter((r) => r.type === 'compaction');
    expect(compactionRecords.length).toBe(1);
    expect((compactionRecords[0] as { archive_file?: string }).archive_file).toBe('wire.1.jsonl');
  });

  it('after compaction, new messages are appended to the new wire.jsonl', async () => {
    // Create initial wire.jsonl
    const originalContent =
      '{"type":"metadata","protocol_version":"2.1","created_at":1000,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}\n' +
      '{"type":"user_message","seq":1,"time":1001,"turn_id":"t1","content":"old message"}\n';
    const filePath = join(workDir, 'wire.jsonl');
    await writeFile(filePath, originalContent, 'utf8');

    // Rotate
    await rotateJournal(workDir);

    // Write compaction record + new user message to the new file
    const lifecycle = new SessionLifecycleStateMachine('active');
    lifecycle.transitionTo('compacting');

    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: {
        get state() {
          const s = lifecycle.state;
          if (s === 'active' || s === 'compacting' || s === 'completing') return s;
          return 'active' as const;
        },
      },
      initialSeq: 0,
      metadataAlreadyWritten: true,
      // Phase 3: pin per-record mode — replay reads wire.jsonl straight
      // after append, so we need synchronous disk durability.
      config: { fsyncMode: 'per-record' },
    });

    // Write compaction record (allowed in compacting state)
    await writer.append({
      type: 'compaction',
      summary: 'Old message was about something.',
      compacted_range: { from_turn: 1, to_turn: 1, message_count: 1 },
      pre_compact_tokens: 50,
      post_compact_tokens: 10,
      trigger: 'auto',
    });

    // Transition back to active for normal writes
    lifecycle.transitionTo('active');

    // Write new conversation after compaction
    await writer.append({
      type: 'user_message',
      turn_id: 't2',
      content: 'new message after compaction',
    });

    // Replay the new file
    const currentReplay = await replayWire(filePath, { supportedMajor: 2 });
    expect(currentReplay.health).toBe('ok');
    expect(currentReplay.records.length).toBe(2);
    expect(currentReplay.records[0]!.type).toBe('compaction');
    expect(currentReplay.records[1]!.type).toBe('user_message');
    expect(currentReplay.records[0]!.seq).toBe(1);
    expect(currentReplay.records[1]!.seq).toBe(2);
  });
});
