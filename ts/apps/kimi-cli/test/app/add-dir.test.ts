/**
 * Phase 21 Slice C.2.2 — `--add-dir` extends `WorkspaceConfig`.
 *
 * The bootstrap logic lives inline in `apps/kimi-cli/src/index.ts`
 * (close to `baseWorkspace`), so we test the same filter rules with a
 * standalone reproduction here. Keeping the rules in sync via a shared
 * helper would be a bigger refactor than this slice warrants.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface FilterResult {
  kept: string[];
  warnings: string[];
}

function filterAddDir(addDir: readonly string[], workDir: string): FilterResult {
  const warnings: string[] = [];
  const kept = addDir
    .map((d) => resolve(d))
    .filter((d) => {
      if (!existsSync(d)) {
        warnings.push(`warning: --add-dir path does not exist, skipped: ${d}`);
        return false;
      }
      if (d === workDir || d.startsWith(workDir + sep)) {
        warnings.push(`warning: --add-dir ${d} is inside work-dir, ignored`);
        return false;
      }
      return true;
    });
  return { kept, warnings };
}

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `kimi-add-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('--add-dir filter', () => {
  it('keeps existing directories outside work-dir', () => {
    const workDir = join(testDir, 'work');
    const extra = join(testDir, 'extra');
    mkdirSync(workDir);
    mkdirSync(extra);

    const { kept, warnings } = filterAddDir([extra], workDir);

    expect(kept).toEqual([extra]);
    expect(warnings).toEqual([]);
  });

  it('drops paths that do not exist with a stderr-style warning', () => {
    const workDir = join(testDir, 'work');
    mkdirSync(workDir);
    const missing = join(testDir, 'missing');

    const { kept, warnings } = filterAddDir([missing], workDir);

    expect(kept).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('does not exist');
  });

  it('drops directories that live inside work-dir to avoid duplicate scopes', () => {
    const workDir = join(testDir, 'work');
    mkdirSync(workDir);
    const inside = join(workDir, 'sub');
    mkdirSync(inside);

    const { kept, warnings } = filterAddDir([inside], workDir);

    expect(kept).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('inside work-dir');
  });
});
