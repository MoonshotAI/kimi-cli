import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalKaos } from '../../src/local.js';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

describe.skipIf(process.platform === 'win32')('e2e: symlink stat parity', () => {
  let kaos: LocalKaos;
  let tempDir: string;

  beforeEach(async () => {
    kaos = new LocalKaos();
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'kaos-symlink-')));
    await kaos.chdir(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('follows file symlinks by default and preserves lstat metadata when followSymlinks=false', async () => {
    const targetFile = join(tempDir, 'target.txt');
    const linkFile = join(tempDir, 'target-link.txt');
    const payload = 'payload through symlink';

    await kaos.writeText(targetFile, payload);
    await symlink(targetFile, linkFile);

    const linkStat = await kaos.stat(linkFile, { followSymlinks: false });
    expect(linkStat.stMode & S_IFMT).toBe(S_IFLNK);

    const resolvedStat = await kaos.stat(linkFile);
    expect(resolvedStat.stMode & S_IFMT).toBe(S_IFREG);
    expect(resolvedStat.stSize).toBe(Buffer.byteLength(payload, 'utf-8'));
    expect(await kaos.readText(linkFile)).toBe(payload);
  });

  it('follows directory symlinks while lstat still reports a symlink', async () => {
    const targetDir = join(tempDir, 'target-dir');
    const linkDir = join(tempDir, 'target-dir-link');
    const nestedFile = join(targetDir, 'nested.txt');

    await kaos.mkdir(targetDir);
    await kaos.writeText(nestedFile, 'directory payload');
    await symlink(targetDir, linkDir);

    const linkStat = await kaos.stat(linkDir, { followSymlinks: false });
    expect(linkStat.stMode & S_IFMT).toBe(S_IFLNK);

    const resolvedStat = await kaos.stat(linkDir);
    expect(resolvedStat.stMode & S_IFMT).toBe(S_IFDIR);

    const entries: string[] = [];
    for await (const entry of kaos.iterdir(linkDir)) {
      entries.push(entry);
    }

    expect(entries).toEqual([join(linkDir, 'nested.txt')]);
  });
});
