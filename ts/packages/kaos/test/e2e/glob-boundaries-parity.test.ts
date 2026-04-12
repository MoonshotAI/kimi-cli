import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalKaos } from '../../src/local.js';

describe('e2e: glob parity boundaries', () => {
  let kaos: LocalKaos;
  let tempDir: string;

  beforeEach(async () => {
    kaos = new LocalKaos();
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'kaos-glob-')));
    await kaos.chdir(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('** traverses hidden directories and yields each nested match only once', async () => {
    await kaos.mkdir(join(tempDir, 'visible', 'nested'), { parents: true });
    await kaos.mkdir(join(tempDir, '.hidden-root'), { parents: true });
    await kaos.mkdir(join(tempDir, 'visible', '.hidden-dir'), { parents: true });

    await kaos.writeText(join(tempDir, 'root-visible.txt'), 'root-visible');
    await kaos.writeText(join(tempDir, '.hidden-root', 'root-hidden.txt'), 'root-hidden');
    await kaos.writeText(join(tempDir, 'visible', 'nested', 'deep.txt'), 'deep');
    await kaos.writeText(join(tempDir, 'visible', '.hidden-dir', 'secret.txt'), 'secret');
    await kaos.writeText(join(tempDir, 'visible', '.hidden-dir', 'skip.log'), 'skip');

    const results: string[] = [];
    for await (const entry of kaos.glob(tempDir, '**/*.txt')) {
      results.push(entry);
    }

    expect(results).toHaveLength(4);
    expect(new Set(results).size).toBe(4);
    expect(results).toEqual(
      expect.arrayContaining([
        join(tempDir, 'root-visible.txt'),
        join(tempDir, '.hidden-root', 'root-hidden.txt'),
        join(tempDir, 'visible', 'nested', 'deep.txt'),
        join(tempDir, 'visible', '.hidden-dir', 'secret.txt'),
      ]),
    );
    expect(results.some((entry) => entry.endsWith('skip.log'))).toBe(false);
  });

  it('root-level glob includes hidden dotfiles', async () => {
    await kaos.writeText(join(tempDir, '.hidden.txt'), 'hidden');
    await kaos.writeText(join(tempDir, 'visible.txt'), 'visible');
    await kaos.writeText(join(tempDir, 'visible.log'), 'log');

    const results: string[] = [];
    for await (const entry of kaos.glob(tempDir, '*.txt')) {
      results.push(entry);
    }

    expect(new Set(results)).toEqual(
      new Set([join(tempDir, '.hidden.txt'), join(tempDir, 'visible.txt')]),
    );
  });
});
