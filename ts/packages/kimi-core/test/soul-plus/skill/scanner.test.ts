/**
 * Skill scanner — Slice 2.5 unit tests, covering the Python-parity
 * regression matrix (`107965a2` empty-generic-shadows-brand bug, root
 * canonicalisation, first-wins merging, malformed SKILL.md skipping).
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverSkills, resolveSkillRoots } from '../../../src/soul-plus/skill/scanner.js';

describe('resolveSkillRoots', () => {
  let tmp: string;
  let home: string;
  let work: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'kimi-skill-scan-'));
    home = path.join(tmp, 'home');
    work = path.join(tmp, 'work');
    await mkdir(home, { recursive: true });
    await mkdir(work, { recursive: true });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function ensureDir(p: string): Promise<void> {
    await mkdir(p, { recursive: true });
  }

  it('returns an empty list when nothing exists', async () => {
    const roots = await resolveSkillRoots({ workDir: work, homeDir: home });
    expect(roots).toEqual([]);
  });

  it('discovers built-in root when provided', async () => {
    const builtin = path.join(tmp, 'builtin-skills');
    await ensureDir(builtin);
    const roots = await resolveSkillRoots({
      workDir: work,
      builtinDir: builtin,
      homeDir: home,
    });
    expect(roots).toHaveLength(1);
    expect(roots[0]?.source).toBe('builtin');
  });

  it('returns user-brand dir in priority order (.kimi > .claude > .codex)', async () => {
    const kimi = path.join(home, '.kimi', 'skills');
    const claude = path.join(home, '.claude', 'skills');
    await ensureDir(kimi);
    await ensureDir(claude);
    const roots = await resolveSkillRoots({ workDir: work, homeDir: home });
    // kimi wins — only the first brand candidate is consumed
    expect(roots.map((r) => r.path)).toEqual([await realpath(kimi)]);
  });

  // ── P0-1 regression: empty generic must not shadow brand ──────────
  it('P0-1: populated user brand directory survives alongside an empty user generic', async () => {
    const kimi = path.join(home, '.kimi', 'skills');
    const emptyGeneric = path.join(home, '.config', 'agents', 'skills');
    await ensureDir(kimi);
    await ensureDir(emptyGeneric);
    const roots = await resolveSkillRoots({ workDir: work, homeDir: home });
    expect(roots.map((r) => r.path)).toEqual([await realpath(kimi), await realpath(emptyGeneric)]);
  });

  it('merges user + project layers when both exist', async () => {
    const userBrand = path.join(home, '.kimi', 'skills');
    const projBrand = path.join(work, '.kimi', 'skills');
    const projGeneric = path.join(work, '.agents', 'skills');
    await ensureDir(userBrand);
    await ensureDir(projBrand);
    await ensureDir(projGeneric);
    const roots = await resolveSkillRoots({ workDir: work, homeDir: home });
    expect(roots.map((r) => `${r.source}:${r.path}`)).toEqual([
      `user:${await realpath(userBrand)}`,
      `project:${await realpath(projBrand)}`,
      `project:${await realpath(projGeneric)}`,
    ]);
  });

  it('explicitDirs overrides user/project discovery but keeps built-in', async () => {
    const builtin = path.join(tmp, 'builtin');
    const custom = path.join(tmp, 'custom-root');
    // Create a user brand dir that should be ignored when explicitDirs is set.
    const kimi = path.join(home, '.kimi', 'skills');
    await ensureDir(builtin);
    await ensureDir(custom);
    await ensureDir(kimi);
    const roots = await resolveSkillRoots({
      workDir: work,
      builtinDir: builtin,
      homeDir: home,
      explicitDirs: [custom],
    });
    expect(roots.map((r) => r.source)).toEqual(['builtin', 'user']);
    expect(roots.map((r) => r.path)).toEqual([await realpath(builtin), await realpath(custom)]);
  });

  // ── P0-2 regression: symlinks must be canonicalised ────────────────
  it('P0-2: symlinked skill root is canonicalised to its real target', async () => {
    const real = path.join(tmp, 'real-skills-target');
    await ensureDir(real);
    // symlink ~/.kimi/skills → real
    const kimi = path.join(home, '.kimi', 'skills');
    await ensureDir(path.dirname(kimi));
    await symlink(real, kimi, 'dir');
    const roots = await resolveSkillRoots({ workDir: work, homeDir: home });
    expect(roots).toHaveLength(1);
    expect(roots[0]?.path).toBe(await realpath(real));
  });
});

describe('discoverSkills', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'kimi-skill-disc-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function writeSkill(root: string, dirName: string, body: string): Promise<void> {
    const dir = path.join(root, dirName);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), body, 'utf8');
  }

  it('finds skills under a single root', async () => {
    const root = path.join(tmp, 'skills');
    await writeSkill(root, 'commit', '---\nname: commit\ndescription: x\n---\nbody');
    await writeSkill(root, 'release', '---\nname: release\ndescription: y\n---\nbody');
    const skills = await discoverSkills({
      roots: [{ path: root, source: 'user' }],
    });
    expect(skills.map((s) => s.name)).toEqual(['commit', 'release']);
  });

  it('first-wins: earlier root overrides later for the same name', async () => {
    const rootA = path.join(tmp, 'a');
    const rootB = path.join(tmp, 'b');
    await writeSkill(rootA, 'greet', '---\nname: greet\ndescription: from-A\n---\nbody-A');
    await writeSkill(rootB, 'greet', '---\nname: greet\ndescription: from-B\n---\nbody-B');
    const skills = await discoverSkills({
      roots: [
        { path: rootA, source: 'builtin' },
        { path: rootB, source: 'user' },
      ],
    });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe('from-A');
    expect(skills[0]?.source).toBe('builtin');
  });

  it('case-insensitive name merging', async () => {
    const rootA = path.join(tmp, 'a');
    const rootB = path.join(tmp, 'b');
    await writeSkill(rootA, 'Greet', '---\nname: Greet\ndescription: upper\n---\n');
    await writeSkill(rootB, 'greet', '---\nname: greet\ndescription: lower\n---\n');
    const skills = await discoverSkills({
      roots: [
        { path: rootA, source: 'user' },
        { path: rootB, source: 'project' },
      ],
    });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe('upper');
  });

  it('skips subdirectories without SKILL.md', async () => {
    const root = path.join(tmp, 'skills');
    await mkdir(path.join(root, 'not-a-skill'), { recursive: true });
    await writeSkill(root, 'real', '---\nname: real\ndescription: r\n---\n');
    const skills = await discoverSkills({ roots: [{ path: root, source: 'user' }] });
    expect(skills.map((s) => s.name)).toEqual(['real']);
  });

  it('skips malformed SKILL.md without blocking startup, reporting via onWarning', async () => {
    const root = path.join(tmp, 'skills');
    // Broken frontmatter:
    await writeSkill(root, 'broken', '---\nname: "oops unterminated\n---\nbody');
    // Valid sibling:
    await writeSkill(root, 'ok', '---\nname: ok\ndescription: fine\n---\n');
    const warnings: string[] = [];
    const skills = await discoverSkills({
      roots: [{ path: root, source: 'user' }],
      onWarning: (msg) => warnings.push(msg),
    });
    expect(skills.map((s) => s.name)).toEqual(['ok']);
    expect(warnings.some((w) => w.includes('broken'))).toBe(true);
  });

  it('type: flow skills are silently skipped by policy (no warning), captured via onSkippedByPolicy', async () => {
    const root = path.join(tmp, 'skills');
    await writeSkill(root, 'flow-thing', '---\nname: flow-thing\ntype: flow\n---\nbody');
    const warnings: string[] = [];
    const skipped: { path: string; type: string; reason: string }[] = [];
    const skills = await discoverSkills({
      roots: [{ path: root, source: 'user' }],
      onWarning: (msg) => warnings.push(msg),
      onSkippedByPolicy: (info) => skipped.push(info),
    });
    expect(skills).toHaveLength(0);
    // No startup stderr noise from the flow-skill policy — it's expected, not an error.
    expect(warnings).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ type: 'flow', reason: expect.any(String) });
    expect(skipped[0]?.path).toContain('flow-thing');
  });

  it('malformed SKILL.md (non-policy error) still fires onWarning, not onSkippedByPolicy', async () => {
    const root = path.join(tmp, 'skills');
    await writeSkill(root, 'broken2', '---\nname: "oops unterminated\n---\nbody');
    const warnings: string[] = [];
    const skipped: unknown[] = [];
    await discoverSkills({
      roots: [{ path: root, source: 'user' }],
      onWarning: (msg) => warnings.push(msg),
      onSkippedByPolicy: (info) => skipped.push(info),
    });
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(skipped).toHaveLength(0);
  });

  it('unsupported non-flow type still routes through onSkippedByPolicy (flow-first is the immediate policy, but the hook covers any supported-set mismatch uniformly)', async () => {
    const root = path.join(tmp, 'skills');
    await writeSkill(root, 'mystery', '---\nname: mystery\ntype: mystery-unknown\n---\nbody');
    const warnings: string[] = [];
    const skipped: { path: string; type: string }[] = [];
    const skills = await discoverSkills({
      roots: [{ path: root, source: 'user' }],
      onWarning: (msg) => warnings.push(msg),
      onSkippedByPolicy: (info) => skipped.push(info),
    });
    expect(skills).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.type).toBe('mystery-unknown');
  });
});

async function realpath(p: string): Promise<string> {
  const { realpath: rp } = await import('node:fs/promises');
  return rp(p);
}
