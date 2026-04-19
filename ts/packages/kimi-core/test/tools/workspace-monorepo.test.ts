import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  discoverMonorepoSiblings,
  extendWorkspaceWithMonorepoSiblings,
} from '../../src/tools/workspace-monorepo.js';

describe('discoverMonorepoSiblings', () => {
  let root: string;
  beforeEach(() => {
    root = join(
      tmpdir(),
      `kimi-mono-${String(Date.now())}-${String(Math.random()).slice(2)}`,
    );
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds siblings via pnpm-workspace.yaml', () => {
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      `packages:\n  - packages/*\n  - apps/*\n`,
    );
    mkdirSync(join(root, 'packages', 'pkg-a'), { recursive: true });
    mkdirSync(join(root, 'packages', 'pkg-b'), { recursive: true });
    mkdirSync(join(root, 'apps', 'cli'), { recursive: true });
    const result = discoverMonorepoSiblings(join(root, 'apps', 'cli'));
    expect(result).toBeDefined();
    expect(result?.root).toBe(root);
    expect([...(result?.siblings ?? [])].sort()).toEqual(
      [
        join(root, 'apps', 'cli'),
        join(root, 'packages', 'pkg-a'),
        join(root, 'packages', 'pkg-b'),
      ].sort(),
    );
  });

  it('finds siblings via package.json workspaces (array)', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    );
    mkdirSync(join(root, 'packages', 'a'), { recursive: true });
    mkdirSync(join(root, 'packages', 'b'), { recursive: true });
    const result = discoverMonorepoSiblings(join(root, 'packages', 'a'));
    expect([...(result?.siblings ?? [])].sort()).toEqual(
      [join(root, 'packages', 'a'), join(root, 'packages', 'b')].sort(),
    );
  });

  it('returns undefined when no manifest within MAX_PARENT_WALK', () => {
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true });
    const result = discoverMonorepoSiblings(join(root, 'a', 'b', 'c'));
    expect(result).toBeUndefined();
  });

  it('ignores negation globs', () => {
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      `packages:\n  - packages/*\n  - '!packages/private'\n`,
    );
    mkdirSync(join(root, 'packages', 'a'), { recursive: true });
    mkdirSync(join(root, 'packages', 'private'), { recursive: true });
    const result = discoverMonorepoSiblings(join(root, 'packages', 'a'));
    expect(result?.siblings).toContain(join(root, 'packages', 'private'));
  });
});

describe('extendWorkspaceWithMonorepoSiblings', () => {
  let root: string;
  beforeEach(() => {
    root = join(
      tmpdir(),
      `kimi-mono2-${String(Date.now())}-${String(Math.random()).slice(2)}`,
    );
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      `packages:\n  - packages/*\n  - apps/*\n`,
    );
    mkdirSync(join(root, 'packages', 'core'), { recursive: true });
    mkdirSync(join(root, 'packages', 'kaos'), { recursive: true });
    mkdirSync(join(root, 'apps', 'cli'), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('adds siblings to additionalDirs; drops self', () => {
    const ws = { workspaceDir: join(root, 'apps', 'cli'), additionalDirs: [] };
    const extended = extendWorkspaceWithMonorepoSiblings(ws, ws.workspaceDir);
    expect(extended.additionalDirs).toContain(join(root, 'packages', 'core'));
    expect(extended.additionalDirs).toContain(join(root, 'packages', 'kaos'));
    expect(extended.additionalDirs).not.toContain(ws.workspaceDir);
  });

  it('keeps existing additionalDirs and avoids duplicates', () => {
    const ws = {
      workspaceDir: join(root, 'apps', 'cli'),
      additionalDirs: [join(root, 'packages', 'core')],
    };
    const extended = extendWorkspaceWithMonorepoSiblings(ws, ws.workspaceDir);
    const coreCount = extended.additionalDirs.filter(
      (d) => d === join(root, 'packages', 'core'),
    ).length;
    expect(coreCount).toBe(1);
    expect(extended.additionalDirs).toContain(join(root, 'packages', 'kaos'));
  });

  it('returns the input unchanged when no monorepo manifest is found', () => {
    const lonely = join(root, 'lonely');
    mkdirSync(lonely, { recursive: true });
    rmSync(join(root, 'pnpm-workspace.yaml'));
    const ws = { workspaceDir: lonely, additionalDirs: [] as const };
    const extended = extendWorkspaceWithMonorepoSiblings(ws, lonely);
    expect(extended).toBe(ws);
  });
});
