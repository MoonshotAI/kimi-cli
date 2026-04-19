/**
 * Slice 6 — Storage-layer compaction tests.
 *
 * Covers:
 *   - `resetToSummary` semantic lock-down (§8 row 1 — deferred from Slice 1)
 *   - `tokenCountWithPending` formula lock-down (§8 row 2 — deferred from Slice 1)
 *   - File rotation (wire.jsonl → wire.N.jsonl)
 *   - Cross-file replay (wire.N.jsonl → ... → wire.jsonl)
 *   - Crash recovery (missing wire.jsonl rollback)
 *   - JournalWriter gating during compacting state
 *
 * All tests are expected to FAIL until the Slice 6 implementer replaces
 * the stubs with real logic.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  listWireFiles,
  nextArchiveName,
  recoverRotation,
  replayWireSession,
  rotateJournal,
} from '../../src/storage/compaction.js';
import { InMemoryContextState, type SummaryMessage } from '../../src/storage/context-state.js';
import * as fsDurability from '../../src/storage/fs-durability.js';
import { replayWire } from '../../src/storage/replay.js';

// ── resetToSummary semantic lock-down (§8 row 1) ─────────────────────

describe('resetToSummary — projection semantics', () => {
  it('after reset, buildMessages() returns exactly 1 message with summary text', async () => {
    const ctx = new InMemoryContextState({ initialModel: 'test-model' });

    // Seed some history
    await ctx.appendUserMessage({ text: 'hello' });
    await ctx.appendAssistantMessage({
      text: 'hi there',
      think: null,
      toolCalls: [],
      model: 'test-model',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    await ctx.appendUserMessage({ text: 'how are you?' });

    const summary: SummaryMessage = {
      summary: 'User greeted assistant. Assistant responded.',
      compactedRange: { fromTurn: 1, toTurn: 2, messageCount: 3 },
      preCompactTokens: 150,
      postCompactTokens: 30,
      trigger: 'auto',
    };

    await ctx.resetToSummary(summary);

    const messages = ctx.buildMessages();
    // Slice 6 lock-down: exactly 1 message — the synthetic summary
    expect(messages.length).toBe(1);
    expect(messages[0]!.role).toBe('assistant');
    // The summary text should appear in the message content
    const textContent = messages[0]!.content.find((c) => c.type === 'text');
    expect(textContent).toBeDefined();
    expect((textContent as { type: 'text'; text: string }).text).toContain(
      'User greeted assistant. Assistant responded.',
    );
  });

  it('after reset, subsequent appendUserMessage works correctly', async () => {
    const ctx = new InMemoryContextState({ initialModel: 'test-model' });

    await ctx.appendUserMessage({ text: 'old message' });

    const summary: SummaryMessage = {
      summary: 'Previous conversation summary.',
      compactedRange: { fromTurn: 1, toTurn: 1, messageCount: 1 },
      preCompactTokens: 100,
      postCompactTokens: 20,
      trigger: 'auto',
    };
    await ctx.resetToSummary(summary);

    // Now add a new message after reset
    await ctx.appendUserMessage({ text: 'new message after compaction' });

    const messages = ctx.buildMessages();
    // Should be: summary message + new user message
    expect(messages.length).toBe(2);
    expect(messages[0]!.role).toBe('assistant'); // summary
    expect(messages[1]!.role).toBe('user'); // new message
  });

  it('after reset, tokenCountWithPending is set to postCompactTokens', async () => {
    const ctx = new InMemoryContextState({ initialModel: 'test-model' });

    await ctx.appendAssistantMessage({
      text: 'long response',
      think: null,
      toolCalls: [],
      model: 'test-model',
      usage: { input_tokens: 5000, output_tokens: 3000 },
    });

    const summary: SummaryMessage = {
      summary: 'Compact summary.',
      compactedRange: { fromTurn: 1, toTurn: 1, messageCount: 1 },
      preCompactTokens: 8000,
      postCompactTokens: 500,
      trigger: 'auto',
    };
    await ctx.resetToSummary(summary);

    expect(ctx.tokenCountWithPending).toBe(500);
  });
});

// ── tokenCountWithPending formula lock-down (§8 row 2) ───────────────

describe('tokenCountWithPending — formula', () => {
  it('starts at 0 for fresh context', () => {
    const ctx = new InMemoryContextState({ initialModel: 'test-model' });
    expect(ctx.tokenCountWithPending).toBe(0);
  });

  it('accumulates from assistant message usage', async () => {
    const ctx = new InMemoryContextState({ initialModel: 'test-model' });

    await ctx.appendAssistantMessage({
      text: 'hello',
      think: null,
      toolCalls: [],
      model: 'test-model',
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    // Formula: input_tokens + output_tokens
    expect(ctx.tokenCountWithPending).toBe(150);
  });

  it('accumulates across multiple assistant messages', async () => {
    const ctx = new InMemoryContextState({ initialModel: 'test-model' });

    await ctx.appendAssistantMessage({
      text: 'first',
      think: null,
      toolCalls: [],
      model: 'test-model',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    await ctx.appendAssistantMessage({
      text: 'second',
      think: null,
      toolCalls: [],
      model: 'test-model',
      usage: { input_tokens: 200, output_tokens: 80 },
    });

    // 150 + 280 = 430
    expect(ctx.tokenCountWithPending).toBe(430);
  });

  it('is not affected by appendUserMessage or appendToolResult', async () => {
    const ctx = new InMemoryContextState({ initialModel: 'test-model' });

    await ctx.appendAssistantMessage({
      text: 'hello',
      think: null,
      toolCalls: [],
      model: 'test-model',
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    await ctx.appendUserMessage({ text: 'user message' });
    await ctx.appendToolResult(undefined, 'tc_1', { output: 'tool result' });

    // Still just from the assistant message usage
    expect(ctx.tokenCountWithPending).toBe(150);
  });

  it('does not count when usage is undefined', async () => {
    const ctx = new InMemoryContextState({ initialModel: 'test-model' });

    await ctx.appendAssistantMessage({
      text: 'no usage',
      think: null,
      toolCalls: [],
      model: 'test-model',
      // No usage field
    });

    expect(ctx.tokenCountWithPending).toBe(0);
  });
});

// ── File rotation ────────────────────────────────────────────────────

describe('rotateJournal — file rotation', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kimi-compaction-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('renames wire.jsonl to wire.1.jsonl on first rotation', async () => {
    // Create a wire.jsonl with some content
    const wireContent =
      [
        '{"type":"metadata","protocol_version":"2.1","created_at":1000,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}',
        '{"type":"user_message","seq":1,"time":1001,"turn_id":"t1","content":"hello"}',
      ].join('\n') + '\n';
    await writeFile(join(workDir, 'wire.jsonl'), wireContent, 'utf8');

    const result = await rotateJournal(workDir);

    // Archive should exist
    const archiveContent = await readFile(join(workDir, 'wire.1.jsonl'), 'utf8');
    expect(archiveContent).toBe(wireContent);

    // New wire.jsonl should have metadata header
    const newContent = await readFile(join(workDir, 'wire.jsonl'), 'utf8');
    const firstLine = JSON.parse(newContent.split('\n')[0]!) as Record<string, unknown>;
    expect(firstLine['type']).toBe('metadata');
    expect(firstLine['protocol_version']).toBe('2.1');

    expect(result.archivePath).toContain('wire.1.jsonl');
  });

  it('increments archive number on subsequent rotations', async () => {
    // Simulate existing archive + current file
    await writeFile(
      join(workDir, 'wire.1.jsonl'),
      '{"type":"metadata","protocol_version":"2.1","created_at":900,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}\n',
      'utf8',
    );
    const wireContent =
      '{"type":"metadata","protocol_version":"2.1","created_at":1000,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}\n' +
      '{"type":"user_message","seq":1,"time":1001,"turn_id":"t1","content":"hello"}\n';
    await writeFile(join(workDir, 'wire.jsonl'), wireContent, 'utf8');

    const result = await rotateJournal(workDir);

    // Should be wire.2.jsonl (not wire.1.jsonl which already exists)
    expect(result.archivePath).toContain('wire.2.jsonl');
    const archive2 = await readFile(join(workDir, 'wire.2.jsonl'), 'utf8');
    expect(archive2).toBe(wireContent);
  });

  it('leaves no .tmp leftover and is replay-healthy after rotate (Slice 6 audit M03)', async () => {
    const wireContent =
      [
        '{"type":"metadata","protocol_version":"2.1","created_at":1000,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}',
        '{"type":"session_initialized","seq":0,"time":0,"agent_type":"main","session_id":"ses_test","system_prompt":"","model":"m","active_tools":[],"permission_mode":"default","plan_mode":false,"workspace_dir":"/tmp/ws"}',
        '{"type":"user_message","seq":1,"time":1001,"turn_id":"t1","content":"hello"}',
      ].join('\n') + '\n';
    await writeFile(join(workDir, 'wire.jsonl'), wireContent, 'utf8');

    await rotateJournal(workDir);
    // Phase 23 — after rotateJournal alone, new wire.jsonl is metadata-only
    // and not yet replay-healthy. The orchestrator's appendBoundary() step
    // writes session_initialized (line 2) and the boundary record (line 3+)
    // right after. Here we simulate that by appending session_initialized so
    // the new file satisfies the line-2 contract.
    const initLine =
      '{"type":"session_initialized","seq":0,"time":0,"agent_type":"main","session_id":"ses_test","system_prompt":"","model":"m","active_tools":[],"permission_mode":"default","plan_mode":false,"workspace_dir":"/tmp/ws"}\n';
    await writeFile(join(workDir, 'wire.jsonl'), (await readFile(join(workDir, 'wire.jsonl'), 'utf8')) + initLine, 'utf8');

    // No `.tmp` file must be left behind by the durable write pattern
    const entries = await readdir(workDir);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);

    // Archive replay still healthy
    const archiveReplay = await replayWire(join(workDir, 'wire.1.jsonl'), { supportedMajor: 2 });
    expect(archiveReplay.health).toBe('ok');
    expect(archiveReplay.records.length).toBe(1);

    // New wire.jsonl replay healthy — session_initialized extracted out, so
    // body records count is 0.
    const currentReplay = await replayWire(join(workDir, 'wire.jsonl'), { supportedMajor: 2 });
    expect(currentReplay.health).toBe('ok');
    expect(currentReplay.records.length).toBe(0);
  });

  it('fsyncs the session directory via the durable helpers (Slice 6 audit M03)', async () => {
    await writeFile(
      join(workDir, 'wire.jsonl'),
      '{"type":"metadata","protocol_version":"2.1","created_at":1000,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}\n',
      'utf8',
    );

    const writeSpy = vi.spyOn(fsDurability, 'writeFileAtomicDurable');
    const syncDirSpy = vi.spyOn(fsDurability, 'syncDir');

    await rotateJournal(workDir);

    // Durable write for the new wire.jsonl must have gone through the
    // atomic helper, and the session directory must have been fsynced
    // at least once (the defensive post-rotate sync; the one inside
    // writeFileAtomicDurable is internal and not counted by the spy).
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(syncDirSpy).toHaveBeenCalled();

    writeSpy.mockRestore();
    syncDirSpy.mockRestore();
  });

  it('cleans up the .tmp file and leaves the archive intact when the durable write throws', async () => {
    const wireContent =
      '{"type":"metadata","protocol_version":"2.1","created_at":1000,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}\n' +
      '{"type":"user_message","seq":1,"time":1001,"turn_id":"t1","content":"pre-rotate"}\n';
    await writeFile(join(workDir, 'wire.jsonl'), wireContent, 'utf8');

    // Simulate an fs error somewhere inside the durable helper.
    const writeSpy = vi
      .spyOn(fsDurability, 'writeFileAtomicDurable')
      .mockRejectedValueOnce(new Error('simulated write failure'));

    await expect(rotateJournal(workDir)).rejects.toThrow('simulated write failure');

    // rename already happened, so the archive must exist intact…
    const archive = await readFile(join(workDir, 'wire.1.jsonl'), 'utf8');
    expect(archive).toBe(wireContent);

    // …and no `.tmp` artefact must be left behind in the session dir.
    const entries = await readdir(workDir);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);

    writeSpy.mockRestore();
  });

  it('preserves original content in frozen archive (append-only invariant)', async () => {
    const originalContent =
      '{"type":"metadata","protocol_version":"2.1","created_at":1000,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}\n' +
      '{"type":"user_message","seq":1,"time":1001,"turn_id":"t1","content":"important"}\n' +
      '{"type":"assistant_message","seq":2,"time":1002,"turn_id":"t1","text":"response","think":null,"tool_calls":[],"model":"m","usage":{"input_tokens":10,"output_tokens":5}}\n';
    await writeFile(join(workDir, 'wire.jsonl'), originalContent, 'utf8');

    await rotateJournal(workDir);

    // Frozen archive must be byte-identical to original
    const archived = await readFile(join(workDir, 'wire.1.jsonl'), 'utf8');
    expect(archived).toBe(originalContent);
  });
});

// ── listWireFiles ─────────────────────────────────────────────────────

describe('listWireFiles — archive enumeration', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kimi-list-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns [wire.jsonl] when no archives exist', async () => {
    await writeFile(join(workDir, 'wire.jsonl'), 'content\n', 'utf8');

    const files = await listWireFiles(workDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain('wire.jsonl');
  });

  it('returns files in age order: oldest (lowest N) first, wire.jsonl last', async () => {
    await writeFile(join(workDir, 'wire.jsonl'), 'current\n', 'utf8');
    await writeFile(join(workDir, 'wire.1.jsonl'), 'oldest archive\n', 'utf8');
    await writeFile(join(workDir, 'wire.3.jsonl'), 'newest archive\n', 'utf8');
    await writeFile(join(workDir, 'wire.2.jsonl'), 'middle archive\n', 'utf8');

    const files = await listWireFiles(workDir);
    expect(files.length).toBe(4);
    // Oldest first (lowest N = oldest, higher N = newer)
    expect(files[0]).toContain('wire.1.jsonl');
    expect(files[1]).toContain('wire.2.jsonl');
    expect(files[2]).toContain('wire.3.jsonl');
    expect(files[3]).toContain('wire.jsonl');
  });

  it('ignores non-wire files', async () => {
    await writeFile(join(workDir, 'wire.jsonl'), 'current\n', 'utf8');
    await writeFile(join(workDir, 'state.json'), '{}', 'utf8');
    await writeFile(join(workDir, 'wire.1.jsonl'), 'archive\n', 'utf8');

    const files = await listWireFiles(workDir);
    expect(files.length).toBe(2);
    expect(files.every((f) => f.includes('wire'))).toBe(true);
  });
});

// ── nextArchiveName ───────────────────────────────────────────────────

describe('nextArchiveName — archive numbering', () => {
  it('returns wire.1.jsonl when no archives exist', () => {
    const name = nextArchiveName('/sessions/s1', []);
    expect(name).toContain('wire.1.jsonl');
  });

  it('returns wire.4.jsonl when highest existing is wire.3.jsonl', () => {
    const name = nextArchiveName('/sessions/s1', ['wire.1.jsonl', 'wire.2.jsonl', 'wire.3.jsonl']);
    expect(name).toContain('wire.4.jsonl');
  });
});

// ── Cross-file replay ─────────────────────────────────────────────────

describe('replayWireSession — cross-file replay', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kimi-replay-session-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('replays single wire.jsonl (no archives)', async () => {
    const content =
      [
        '{"type":"metadata","protocol_version":"2.1","created_at":1000,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}',
        '{"type":"session_initialized","seq":0,"time":0,"agent_type":"main","session_id":"ses_test","system_prompt":"","model":"m","active_tools":[],"permission_mode":"default","plan_mode":false,"workspace_dir":"/tmp/ws"}',
        '{"type":"user_message","seq":1,"time":1001,"turn_id":"t1","content":"hello"}',
      ].join('\n') + '\n';
    await writeFile(join(workDir, 'wire.jsonl'), content, 'utf8');

    const result = await replayWireSession(workDir, { supportedMajor: 2 });

    expect(result.health).toBe('ok');
    expect(result.records.length).toBe(1);
    expect(result.records[0]!.type).toBe('user_message');
  });

  it('replays across multiple files in correct order', async () => {
    // Oldest archive (wire.1.jsonl) — higher N = newer
    const archive1 =
      [
        '{"type":"metadata","protocol_version":"2.1","created_at":800,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}',
        '{"type":"session_initialized","seq":0,"time":0,"agent_type":"main","session_id":"ses_test","system_prompt":"","model":"m","active_tools":[],"permission_mode":"default","plan_mode":false,"workspace_dir":"/tmp/ws"}',
        '{"type":"user_message","seq":1,"time":801,"turn_id":"t1","content":"oldest"}',
      ].join('\n') + '\n';
    await writeFile(join(workDir, 'wire.1.jsonl'), archive1, 'utf8');

    // Newer archive (wire.2.jsonl) — line 2 session_initialized + boundary record
    const archive2 =
      [
        '{"type":"metadata","protocol_version":"2.1","created_at":900,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}',
        '{"type":"session_initialized","seq":0,"time":0,"agent_type":"main","session_id":"ses_test","system_prompt":"","model":"m","active_tools":[],"permission_mode":"default","plan_mode":false,"workspace_dir":"/tmp/ws"}',
        '{"type":"compaction","seq":1,"time":901,"summary":"summary of first batch","compacted_range":{"from_turn":1,"to_turn":1,"message_count":1},"pre_compact_tokens":100,"post_compact_tokens":20,"trigger":"auto"}',
        '{"type":"user_message","seq":2,"time":902,"turn_id":"t2","content":"middle"}',
      ].join('\n') + '\n';
    await writeFile(join(workDir, 'wire.2.jsonl'), archive2, 'utf8');

    // Current file (wire.jsonl) — line 2 session_initialized + boundary record
    const current =
      [
        '{"type":"metadata","protocol_version":"2.1","created_at":1000,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}',
        '{"type":"session_initialized","seq":0,"time":0,"agent_type":"main","session_id":"ses_test","system_prompt":"","model":"m","active_tools":[],"permission_mode":"default","plan_mode":false,"workspace_dir":"/tmp/ws"}',
        '{"type":"compaction","seq":1,"time":1001,"summary":"summary of middle batch","compacted_range":{"from_turn":2,"to_turn":2,"message_count":1},"pre_compact_tokens":100,"post_compact_tokens":20,"trigger":"auto"}',
        '{"type":"user_message","seq":2,"time":1002,"turn_id":"t3","content":"newest"}',
      ].join('\n') + '\n';
    await writeFile(join(workDir, 'wire.jsonl'), current, 'utf8');

    const result = await replayWireSession(workDir, { supportedMajor: 2 });

    expect(result.health).toBe('ok');
    // All records from all files
    expect(result.records.length).toBe(5);
    // First record is from the oldest archive
    expect(result.records[0]!.type).toBe('user_message');
    // Last record is from the current file
    expect(result.records.at(-1)!.type).toBe('user_message');
  });

  it('propagates broken health from any file', async () => {
    // Current file has mid-file corruption
    const content =
      [
        '{"type":"metadata","protocol_version":"2.1","created_at":1000,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}',
        '{"type":"session_initialized","seq":0,"time":0,"agent_type":"main","session_id":"ses_test","system_prompt":"","model":"m","active_tools":[],"permission_mode":"default","plan_mode":false,"workspace_dir":"/tmp/ws"}',
        '{"type":"user_message","seq":1,"time":1001,"turn_id":"t1","content":"ok"}',
        'CORRUPTED LINE',
        '{"type":"user_message","seq":2,"time":1003,"turn_id":"t1","content":"after corruption"}',
      ].join('\n') + '\n';
    await writeFile(join(workDir, 'wire.jsonl'), content, 'utf8');

    const result = await replayWireSession(workDir, { supportedMajor: 2 });

    expect(result.health).toBe('broken');
  });
});

// ── Crash recovery ───────────────────────────────────────────────────

describe('recoverRotation — crash recovery', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kimi-recovery-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns false when wire.jsonl exists (no recovery needed)', async () => {
    await writeFile(join(workDir, 'wire.jsonl'), 'content\n', 'utf8');

    const recovered = await recoverRotation(workDir);
    expect(recovered).toBe(false);
  });

  it('rolls back highest archive when wire.jsonl is missing', async () => {
    // Simulate crash: wire.jsonl was renamed to wire.1.jsonl but new file not created
    const archiveContent =
      '{"type":"metadata","protocol_version":"2.1","created_at":1000,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}\n' +
      '{"type":"user_message","seq":1,"time":1001,"turn_id":"t1","content":"hello"}\n';
    await writeFile(join(workDir, 'wire.1.jsonl'), archiveContent, 'utf8');
    // wire.jsonl does NOT exist

    const recovered = await recoverRotation(workDir);

    expect(recovered).toBe(true);
    // wire.jsonl should now exist with the archived content
    const content = await readFile(join(workDir, 'wire.jsonl'), 'utf8');
    expect(content).toBe(archiveContent);
  });

  it('rolls back the highest-numbered archive when multiple exist', async () => {
    // Convention: higher N = newer (more recently archived).
    // After 1st compaction: wire.1.jsonl (frozen), wire.jsonl (new)
    // After 2nd compaction: wire.1 stays, wire.jsonl → wire.2.jsonl, new wire.jsonl
    // Crash during 3rd: wire.jsonl → wire.3.jsonl, then crash before new wire.jsonl
    // Recovery: roll back wire.3 (highest = most recently created) → wire.jsonl
    //
    // This test simulates crash after 2nd compaction:
    // wire.1.jsonl (oldest archive), wire.2.jsonl (just renamed, newest), no wire.jsonl

    await writeFile(join(workDir, 'wire.1.jsonl'), 'oldest archive\n', 'utf8');
    const newestArchive =
      '{"type":"metadata","protocol_version":"2.1","created_at":1000,"producer":{"kind":"typescript","name":"@moonshot-ai/core","version":"1.0.0"}}\n' +
      '{"type":"user_message","seq":1,"time":1001,"turn_id":"t1","content":"recent"}\n';
    await writeFile(join(workDir, 'wire.2.jsonl'), newestArchive, 'utf8');

    const recovered = await recoverRotation(workDir);

    expect(recovered).toBe(true);
    // wire.2.jsonl (newest archive = highest number) rolled back to wire.jsonl
    const content = await readFile(join(workDir, 'wire.jsonl'), 'utf8');
    expect(content).toBe(newestArchive);
  });
});
