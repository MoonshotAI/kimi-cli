/**
 * PlanFileManager — Phase 18 Section D.2 tests.
 *
 * Pins the CRUD contract for `~/.kimi/plans/<slug>.md`:
 *   - getCurrentPlanPath() returns `<home>/plans/<slug>.md`
 *   - readCurrentPlan() returns null when the file does not exist
 *   - writeCurrentPlan(content) creates the plans directory if absent
 *   - clearCurrentPlan() removes the file (no-op if absent)
 *
 * Constructor wiring (v2 §11 / Phase 18 D.2 / D.7):
 *   - `paths: PathConfig` + `sessionId: string` + `slugProvider`
 *     (or SessionMetaService that yields `plan_slug`).
 *
 * RED until the module exists.
 */

import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PathConfig } from '../../src/session/path-config.js';
// Module added in Phase 18 D.2 implementation.
import { PlanFileManager } from '../../src/storage/plan-file-manager.js';

interface PlanFileManagerDeps {
  readonly paths: PathConfig;
  readonly sessionId: string;
  /** Resolves to the per-session slug (from SessionMetaService). */
  readonly getSlug: () => string;
}

// Force the `PlanFileManager` constructor shape without importing the
// real type (module is RED).
type Ctor = new (deps: PlanFileManagerDeps) => {
  getCurrentPlanPath(): string;
  readCurrentPlan(): Promise<string | null>;
  writeCurrentPlan(content: string): Promise<void>;
  clearCurrentPlan(): Promise<void>;
};
const PlanFileManagerCtor = PlanFileManager as unknown as Ctor;

describe('PlanFileManager', () => {
  let home: string;
  let paths: PathConfig;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'kimi-plan-file-mgr-'));
    paths = new PathConfig({ home });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('getCurrentPlanPath returns <home>/plans/<slug>.md', () => {
    const mgr = new PlanFileManagerCtor({
      paths,
      sessionId: 'ses_1',
      getSlug: () => 'iron-man-thor-hulk',
    });
    const expected = path.join(home, 'plans', 'iron-man-thor-hulk.md');
    expect(mgr.getCurrentPlanPath()).toBe(expected);
  });

  it('readCurrentPlan returns null when the plan file does not exist', async () => {
    const mgr = new PlanFileManagerCtor({
      paths,
      sessionId: 'ses_2',
      getSlug: () => 'thor-hulk-vision',
    });
    const content = await mgr.readCurrentPlan();
    expect(content).toBeNull();
  });

  it('writeCurrentPlan creates the plans directory and the file', async () => {
    const mgr = new PlanFileManagerCtor({
      paths,
      sessionId: 'ses_3',
      getSlug: () => 'hawkeye-falcon-wasp',
    });
    await mgr.writeCurrentPlan('# Plan\n- step 1\n- step 2\n');
    const planPath = mgr.getCurrentPlanPath();
    const contents = await readFile(planPath, 'utf8');
    expect(contents).toContain('# Plan');
    expect(contents).toContain('step 2');
  });

  it('readCurrentPlan returns the content after writeCurrentPlan', async () => {
    const mgr = new PlanFileManagerCtor({
      paths,
      sessionId: 'ses_4',
      getSlug: () => 'vision-scarlet-witch-doctor-strange',
    });
    await mgr.writeCurrentPlan('hello plan');
    const got = await mgr.readCurrentPlan();
    expect(got).toBe('hello plan');
  });

  it('clearCurrentPlan removes the plan file', async () => {
    const mgr = new PlanFileManagerCtor({
      paths,
      sessionId: 'ses_5',
      getSlug: () => 'spider-man-groot-rocket',
    });
    await mgr.writeCurrentPlan('something');
    await mgr.clearCurrentPlan();
    const got = await mgr.readCurrentPlan();
    expect(got).toBeNull();
  });

  it('clearCurrentPlan is a no-op when the file does not exist', async () => {
    const mgr = new PlanFileManagerCtor({
      paths,
      sessionId: 'ses_6',
      getSlug: () => 'storm-cyclops-jean-grey',
    });
    // Must not throw.
    await expect(mgr.clearCurrentPlan()).resolves.toBeUndefined();
  });

  it('writeCurrentPlan overwrites an existing plan file', async () => {
    const mgr = new PlanFileManagerCtor({
      paths,
      sessionId: 'ses_7',
      getSlug: () => 'cable-bishop-domino',
    });
    await mgr.writeCurrentPlan('v1');
    await mgr.writeCurrentPlan('v2');
    const got = await mgr.readCurrentPlan();
    expect(got).toBe('v2');
  });

  it('reads a plan that was placed on disk by an external writer', async () => {
    const slug = 'daredevil-elektra-punisher';
    const mgr = new PlanFileManagerCtor({
      paths,
      sessionId: 'ses_8',
      getSlug: () => slug,
    });
    const planPath = mgr.getCurrentPlanPath();
    // Simulate a previous process writing the plan
    await writeFile(planPath, '# From previous session', 'utf8').catch(async () => {
      // Parent dir may not exist yet — create it via the manager first.
      await mgr.writeCurrentPlan('bootstrap');
      await writeFile(planPath, '# From previous session', 'utf8');
    });
    const got = await mgr.readCurrentPlan();
    expect(got).toContain('From previous session');
  });
});
