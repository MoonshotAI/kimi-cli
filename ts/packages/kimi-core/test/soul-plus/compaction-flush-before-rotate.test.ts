// Phase 3 (Slice 3) — TurnManager.executeCompaction must flush the
// journal's pending record buffer BEFORE asking the JournalCapability to
// rotate wire.jsonl.
//
// Why this is load-bearing (v2 §4.5.4 + PROGRESS.md 铁律 5):
//   JournalWriter's async-batch mode buffers records in memory and drains
//   them on a ~50 ms timer. If `rotateJournal` renames the current
//   wire.jsonl to wire.N.jsonl WITHOUT flushing first, any record still
//   in `pendingRecords` will eventually drain — but by then, the old file
//   is already archived, so those records land in the NEW wire.jsonl,
//   *after* the `compaction` marker. On replay that reads "the compaction
//   happened first, then these records were appended", which violates the
//   §9.x recovery contract that pre-compaction records live only in the
//   archive file.
//
// The fix is a single `await this.deps.journalWriter.flush()` (or
// equivalent, routed through ContextState / JournalCapability) in
// `executeCompaction`, placed immediately before the
// `journalCapability.rotate(...)` call.
//
// This test exercises the full TurnManager.triggerCompaction → executeCompaction
// path with a real `WiredJournalWriter` on tmpdir. We inspect the
// wire.jsonl state AT the moment `journalCapability.rotate()` is invoked.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CompactionProvider,
  JournalCapability,
  KosongAdapter,
  Runtime,
  SummaryMessage,
} from '../../src/soul/index.js';
import {
  SessionEventBus,
  SessionLifecycleStateMachine,
  SoulRegistry,
  TurnManager,
} from '../../src/soul-plus/index.js';
import type { TurnManagerDeps } from '../../src/soul-plus/index.js';
import { WiredContextState } from '../../src/storage/context-state.js';
import {
  type LifecycleGate as JournalLifecycleGate,
  type LifecycleState as JournalLifecycleState,
  WiredJournalWriter,
} from '../../src/storage/journal-writer.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import { CompactionOrchestrator } from '../../src/soul-plus/compaction-orchestrator.js';
import { PermissionClosureBuilder } from '../../src/soul-plus/permission-closure-builder.js';
import { TurnLifecycleTracker } from '../../src/soul-plus/turn-lifecycle-tracker.js';
import { WakeQueueScheduler } from '../../src/soul-plus/wake-queue-scheduler.js';

class StubGate implements JournalLifecycleGate {
  state: JournalLifecycleState = 'active';
}

const noopKosong: KosongAdapter = {
  async chat(): ReturnType<KosongAdapter['chat']> {
    throw new Error('kosong.chat should not be reached in a pure /compact trigger test');
  },
};

function compactionProviderReturning(summary: SummaryMessage): CompactionProvider {
  return {
    async run(): Promise<SummaryMessage> {
      return summary;
    },
  };
}

async function countNonMetadataLines(filePath: string): Promise<number> {
  const text = await readFile(filePath, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .filter((line) => {
      try {
        return (JSON.parse(line) as { type: string }).type !== 'metadata';
      } catch {
        return false;
      }
    }).length;
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'kimi-flush-rotate-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TurnManager.executeCompaction — flush before rotate (Phase 3)', () => {
  it('pendingRecords are durable on disk BEFORE journalCapability.rotate runs', async () => {
    // Long drain interval — the only way records reach disk before rotate
    // is an explicit flush() call from inside executeCompaction.
    vi.useFakeTimers();
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { drainIntervalMs: 10_000 },
    });
    const contextState = new WiredContextState({
      journalWriter: writer,
      initialModel: 'test-model',
      currentTurnId: () => 't-pre',
    });

    // Put 5 non-force-flush records into pendingRecords.
    for (let i = 0; i < 5; i++) {
      await contextState.appendAssistantMessage({
        text: `pending-${i}`,
        think: null,
        toolCalls: [],
        model: 'test-model',
      });
    }
    // Assumption check: pending is indeed in memory, not on disk yet.
    expect(writer.pendingRecords.length).toBe(5);
    expect(await countNonMetadataLines(filePath)).toBe(0);

    // Spy on writer.flush — must be called before rotate.
    const flushSpy = vi.spyOn(writer, 'flush');

    // Capture journalCapability.rotate() invocation order and the disk
    // state at that moment.
    let diskBodyLinesAtRotate = -1;
    let pendingAtRotate = -1;
    let flushCallsAtRotate = -1;
    const journalCapability: JournalCapability = {
      async rotate() {
        diskBodyLinesAtRotate = await countNonMetadataLines(filePath);
        pendingAtRotate = writer.pendingRecords.length;
        flushCallsAtRotate = flushSpy.mock.calls.length;
        return { archiveFile: 'wire.1.jsonl' };
      },
    };

    const stateMachine = new SessionLifecycleStateMachine(); // starts in 'idle'
    const sessionJournal = new InMemorySessionJournalImpl();
    const sink = new SessionEventBus();
    const soulRegistry = new SoulRegistry({
      createHandle: (key) => ({
        key,
        agentId: 'agent_main',
        abortController: new AbortController(),
      }),
    });
    const compactionProvider = compactionProviderReturning({
      content: 'summary text',
      original_turn_count: 1,
      original_token_count: 100,
    });
    const runtime: Runtime = { kosong: noopKosong };
    const compaction = new CompactionOrchestrator({
      contextState,
      compactionProvider,
      lifecycleStateMachine: stateMachine,
      journalCapability,
      sink,
      journalWriter: writer,
    });
    const deps = {
      contextState,
      sessionJournal,
      runtime,
      sink,
      lifecycleStateMachine: stateMachine,
      soulRegistry,
      tools: [],
      compaction,
      permissionBuilder: new PermissionClosureBuilder({}),
      lifecycle: new TurnLifecycleTracker(),
      wakeScheduler: new WakeQueueScheduler(),
    } as unknown as TurnManagerDeps;
    const manager = new TurnManager(deps);

    await manager.triggerCompaction('manual compaction');

    // Contract: by the time rotate() was called,
    //   (1) writer.flush() had been invoked at least once, and
    //   (2) pendingRecords was empty, and
    //   (3) all 5 records were already in the pre-rotation wire.jsonl.
    expect(flushCallsAtRotate).toBeGreaterThanOrEqual(1);
    expect(pendingAtRotate).toBe(0);
    expect(diskBodyLinesAtRotate).toBe(5);
  });
});
