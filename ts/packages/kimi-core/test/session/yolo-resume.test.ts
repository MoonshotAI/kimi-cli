/**
 * Phase 24 — 24a bug: E2E resume test for setYolo persistence.
 *
 * The correct flow (DefaultSessionControl.setYolo → journal write → resume)
 * MUST survive a close + resume cycle.  The buggy handler path skips the
 * journal write when `approvalStateStore` is present in installDefaultHandlers,
 * so the permission mode is lost on resume.
 *
 * These tests exercise the E2E path through SessionManager to verify that
 * permission_mode_changed wire records round-trip correctly through the
 * create → setYolo → close → resume lifecycle.
 *
 * Tests 1 and 2 PASS via DefaultSessionControl (correct path).
 * The deeper issue (handler bug) is demonstrated in yolo-wire-write.test.ts L2.
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
  tmpDir = await mkdtemp(join(tmpdir(), 'kimi-24a-resume-'));
  paths = new PathConfig({ home: tmpDir });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('Phase 24 24a — yolo permission mode persists through resume', () => {
  it('create → setYolo(true) → close → resume → permissionMode is bypassPermissions', async () => {
    const mgr = new SessionManager(paths);

    const session = await mgr.createSession({
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
    });
    const { sessionId } = session;

    // Use DefaultSessionControl path (writes permission_mode_changed wire record)
    await session.sessionControl.setYolo(true);

    await mgr.closeSession(sessionId);

    // Resume: replay-projector must reconstruct permission mode from wire.jsonl
    const resumed = await mgr.resumeSession(sessionId, {
      runtime: createNoopRuntime(),
      tools: [],
    });

    const permMode = resumed.soulPlus.getTurnManager().getPermissionMode();
    expect(permMode).toBe('bypassPermissions');
  });

  it('create → setYolo(true) → setYolo(false) → close → resume → permissionMode is default', async () => {
    const mgr = new SessionManager(paths);

    const session = await mgr.createSession({
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
    });
    const { sessionId } = session;

    await session.sessionControl.setYolo(true);
    await session.sessionControl.setYolo(false);

    await mgr.closeSession(sessionId);

    const resumed = await mgr.resumeSession(sessionId, {
      runtime: createNoopRuntime(),
      tools: [],
    });

    const permMode = resumed.soulPlus.getTurnManager().getPermissionMode();
    expect(permMode).toBe('default');
  });
});
