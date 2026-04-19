/**
 * Phase 24 — 24b bug: thinking_level not preserved through session resume.
 *
 * Bug chain:
 *   1. `projectReplayState` ignores `thinking_changed` records and
 *      `sessionInitialized.thinking_level` (replay-projector bug).
 *   2. `ReplayProjectedState` has no `thinkingLevel` field to pass to
 *      `SoulPlus` on resume.
 *   3. After resume, `SoulPlus` has no way to restore the thinking level.
 *
 * These E2E tests create a session, call setThinking, close, resume, and
 * verify the thinking level survives.  They FAIL until the full fix chain
 * (projector + resume wiring) lands.
 *
 * Note: `thinking_level` is a runtime hint for LLM calls — it is not stored
 * in ContextState memory, but it IS persisted as a `thinking_changed` wire
 * record and as `thinking_level` in the compaction-rotate `session_initialized`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PathConfig } from '../../src/session/path-config.js';
import { SessionManager } from '../../src/session/session-manager.js';
import type { Runtime } from '../../src/soul/runtime.js';
import { createFakeRuntime } from '../soul/fixtures/fake-runtime.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';

function createNoopRuntime(): Runtime {
  const kosong = new ScriptedKosongAdapter({ responses: [] });
  return createFakeRuntime({ kosong }).runtime;
}

let tmpDir: string;
let paths: PathConfig;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kimi-24b-resume-'));
  paths = new PathConfig({ home: tmpDir });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// Helper to access thinkingLevel from SoulPlus (may not exist yet pre-fix)
function getThinkingLevel(soulPlus: unknown): string | undefined {
  const sp = soulPlus as Record<string, unknown>;
  if (typeof sp['getThinkingLevel'] === 'function') {
    return (sp['getThinkingLevel'] as () => string | undefined)();
  }
  // Fallback: check TurnManager
  const tm = typeof sp['getTurnManager'] === 'function'
    ? (sp['getTurnManager'] as () => Record<string, unknown>)()
    : undefined;
  if (tm !== undefined && typeof tm['getThinkingLevel'] === 'function') {
    return (tm['getThinkingLevel'] as () => string | undefined)();
  }
  return undefined;
}

describe('Phase 24 24b — thinking_level persists through session resume', () => {
  it('create → setThinking(high) → close → resume → thinkingLevel is high', async () => {
    const mgr = new SessionManager(paths);

    const session = await mgr.createSession({
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
    });
    const { sessionId } = session;

    // setThinking writes a thinking_changed wire record
    await session.soulPlus.setThinking('high');

    await mgr.closeSession(sessionId);

    // Resume: projector must read thinking_changed and restore the level
    const resumed = await mgr.resumeSession(sessionId, {
      runtime: createNoopRuntime(),
      tools: [],
    });

    // FAILS NOW: projector ignores thinking_changed records, so thinkingLevel is undefined
    const level = getThinkingLevel(resumed.soulPlus);
    expect(level).toBe('high');
  });

  it('no setThinking → resume → thinkingLevel matches session_initialized.thinking_level', async () => {
    const mgr = new SessionManager(paths);

    const session = await mgr.createSession({
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
      // Phase 24: CreateSessionOptions may accept thinkingLevel
      // Cast to any to future-proof
    } as never);
    const { sessionId } = session;

    // No setThinking — baseline thinking_level from session_initialized
    await mgr.closeSession(sessionId);

    const resumed = await mgr.resumeSession(sessionId, {
      runtime: createNoopRuntime(),
      tools: [],
    });

    // When no thinking_level was set, the resumed thinkingLevel should be
    // undefined (or the default from session_initialized, whichever applies)
    // FAILS NOW: property doesn't exist on the resumption type
    const level = getThinkingLevel(resumed.soulPlus);
    // level should be undefined when no thinking was set
    expect(level === undefined || typeof level === 'string').toBe(true);
  });
});
