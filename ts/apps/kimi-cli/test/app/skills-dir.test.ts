/**
 * Phase 21 Slice C.2.4 — `--skills-dir` overrides skill discovery.
 *
 * Drives `resolveSkillRoots` directly: with `--skills-dir` we expect the
 * scanner to skip the user/project candidate chain and return only the
 * supplied directories (each tagged `source: 'user'`); without the flag
 * it falls back to the default discovery layers.
 */

import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveSkillRoots } from '@moonshot-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `kimi-skills-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('resolveSkillRoots with explicit --skills-dir', () => {
  it('returns only the supplied directories when explicitDirs is non-empty', async () => {
    const workDir = join(testDir, 'work');
    const home = join(testDir, 'home');
    const explicit = join(testDir, 'custom-skills');
    mkdirSync(workDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(explicit, { recursive: true });
    // Create a default-discovery candidate too so we can tell it was skipped.
    mkdirSync(join(home, '.kimi/skills'), { recursive: true });

    const roots = await resolveSkillRoots({
      workDir,
      homeDir: home,
      explicitDirs: [explicit],
    });

    expect(roots.map((r) => r.path)).toEqual([realpathSync(explicit)]);
    expect(roots[0]?.source).toBe('user');
  });

  it('falls back to default discovery when --skills-dir is absent', async () => {
    const workDir = join(testDir, 'work');
    const home = join(testDir, 'home');
    mkdirSync(workDir, { recursive: true });
    mkdirSync(join(home, '.kimi/skills'), { recursive: true });

    const roots = await resolveSkillRoots({ workDir, homeDir: home });

    expect(roots).toHaveLength(1);
    expect(roots[0]?.source).toBe('user');
    expect(roots[0]?.path).toBe(realpathSync(join(home, '.kimi/skills')));
  });
});
