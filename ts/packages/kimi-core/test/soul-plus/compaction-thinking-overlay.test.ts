/**
 * Phase 24 — 24b bug: compaction applyRuntimeOverlay does not include
 * thinking_level in the mutable fields overlay.
 *
 * Bug: `compaction-orchestrator.ts:applyRuntimeOverlay()` treats
 * `thinking_level` as an "identity-class" field (preserved verbatim from
 * the original `session_initialized` baseline). But `thinking_level` IS
 * mutable at runtime via `setThinking()`. After a compaction rotate, the
 * new `session_initialized` line should carry the CURRENT `thinking_level`,
 * not the original startup value.
 *
 * Comment in compaction-orchestrator.ts:314 is WRONG:
 *   "thinking_level preserved verbatim because they cannot legally mutate"
 *   — this is incorrect; setThinking() mutates it at runtime.
 *
 * Fix: add `thinking_level` to the overlay fields in `applyRuntimeOverlay`.
 * The orchestrator must obtain the current thinking level from TurnManager
 * (or SoulPlus) and include it in the overlay arg.
 *
 * All tests FAIL until the fix lands.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PathConfig } from '../../src/session/path-config.js';
import { SessionManager } from '../../src/session/session-manager.js';
import type { Runtime } from '../../src/soul/runtime.js';
import type { CompactionProvider, SummaryMessage } from '../../src/soul/index.js';
import { createFakeRuntime } from '../soul/fixtures/fake-runtime.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';

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
  tmpDir = await mkdtemp(join(tmpdir(), 'kimi-24b-compact-'));
  paths = new PathConfig({ home: tmpDir });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('Phase 24 24b — compaction rotate preserves current thinking_level', () => {
  it('setThinking(high) → compact → new session_initialized has thinking_level:high', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_think_compact',
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
      compactionProvider: summaryProvider('SUMMARY'),
    });

    // Add content so compact has something to process
    await session.contextState.appendUserMessage({ text: 'hello' }, 'turn_1');
    await session.contextState.appendAssistantMessage({
      text: 'hi',
      think: null,
      toolCalls: [],
      model: 'test-model',
      usage: { input_tokens: 5, output_tokens: 5 },
    });

    // Set thinking level AFTER session started (runtime mutation)
    await session.soulPlus.setThinking('high');

    // Trigger compaction rotate
    await session.soulPlus.getTurnManager().triggerCompaction('manual');
    await session.journalWriter.flush();

    // Read the new wire.jsonl post-rotate
    const wirePath = paths.wirePath('ses_think_compact');
    const lines = await readWireLines(wirePath);

    // line 2 (index 1) should be session_initialized
    const sessionInit = lines[1];
    expect(sessionInit!['type']).toBe('session_initialized');

    // FAILS NOW: thinking_level is NOT in the overlay → remains undefined
    // After fix: thinking_level should be 'high'
    expect(sessionInit!['thinking_level']).toBe('high');
  });

  it('no setThinking → compact → new session_initialized has thinking_level:undefined', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_no_think_compact',
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
      compactionProvider: summaryProvider('S'),
    });

    await session.contextState.appendUserMessage({ text: 'q' }, 'turn_1');
    await session.contextState.appendAssistantMessage({
      text: 'a',
      think: null,
      toolCalls: [],
      model: 'test-model',
      usage: { input_tokens: 5, output_tokens: 5 },
    });

    // No setThinking called
    await session.soulPlus.getTurnManager().triggerCompaction('manual');
    await session.journalWriter.flush();

    const wirePath = paths.wirePath('ses_no_think_compact');
    const lines = await readWireLines(wirePath);
    const sessionInit = lines[1];
    expect(sessionInit!['type']).toBe('session_initialized');

    // Without setThinking, thinking_level should be absent / undefined
    expect(sessionInit!['thinking_level']).toBeUndefined();
  });

  it('setThinking(medium) → compact → resume → thinkingLevel is medium', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_think_resume_compact',
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
      compactionProvider: summaryProvider('S'),
    });

    await session.contextState.appendUserMessage({ text: 'q' }, 'turn_1');
    await session.contextState.appendAssistantMessage({
      text: 'a',
      think: null,
      toolCalls: [],
      model: 'test-model',
      usage: { input_tokens: 5, output_tokens: 5 },
    });

    await session.soulPlus.setThinking('medium');
    await session.soulPlus.getTurnManager().triggerCompaction('manual');
    await session.journalWriter.flush();
    await mgr.closeSession('ses_think_resume_compact');

    // Resume must pick up thinking_level from the post-compact session_initialized
    const resumed = await mgr.resumeSession('ses_think_resume_compact', {
      runtime: createNoopRuntime(),
      tools: [],
    });

    // FAILS NOW: projector doesn't read thinking_level → undefined after resume
    const sp = resumed.soulPlus as unknown as Record<string, unknown>;
    const thinkingLevel = typeof sp['getThinkingLevel'] === 'function'
      ? (sp['getThinkingLevel'] as () => string | undefined)()
      : undefined;
    expect(thinkingLevel).toBe('medium');
  });
});
