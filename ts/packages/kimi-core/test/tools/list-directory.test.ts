import { describe, expect, it } from 'vitest';

import type { Kaos } from '@moonshot-ai/kaos';

import { listDirectory } from '../../src/tools/list-directory.js';
import { createFakeKaos } from './fixtures/fake-kaos.js';

describe('listDirectory', () => {
  it('renders a two-level tree with dirs first then files', async () => {
    const kaos = createFakeKaos({
      iterdir: (async function* (p: string) {
        if (p === '/w') {
          yield '/w/src';
          yield '/w/README.md';
          yield '/w/package.json';
        } else if (p === '/w/src') {
          yield '/w/src/index.ts';
          yield '/w/src/utils.ts';
        }
      }) as unknown as Kaos['iterdir'],
      stat: (async (p: string) => ({
        // list-directory reads stMode: S_IFDIR (0o040000) vs S_IFREG (0o100000).
        stMode: p.endsWith('src') ? 0o040_755 : 0o100_644,
        stIno: 1,
        stDev: 1,
        stNlink: 1,
        stUid: 0,
        stGid: 0,
        stSize: 1,
        stAtime: 0,
        stMtime: 0,
        stCtime: 0,
      })) as unknown as Kaos['stat'],
    });
    const tree = await listDirectory(kaos, '/w');
    expect(tree.split('\n')[0]).toContain('src/');
    expect(tree).toMatch(/README\.md(?!\/)/);
    expect(tree).toMatch(/index\.ts/);
    expect(tree).toMatch(/utils\.ts/);
  });

  it('returns "(empty directory)" when the dir has no entries', async () => {
    const kaos = createFakeKaos({
      // eslint-disable-next-line require-yield
      iterdir: (async function* (_p: string) {}) as unknown as Kaos['iterdir'],
    });
    const result = await listDirectory(kaos, '/empty');
    expect(result).toBe('(empty directory)');
  });

  it('truncates to LIST_DIR_ROOT_WIDTH entries at depth 0', async () => {
    const kaos = createFakeKaos({
      iterdir: (async function* (_p: string) {
        for (let i = 0; i < 50; i++) {
          yield `/w/file_${String(i).padStart(2, '0')}.txt`;
        }
      }) as unknown as Kaos['iterdir'],
      stat: (async () => ({
        stMode: 0o100_644,
        stIno: 1,
        stDev: 1,
        stNlink: 1,
        stUid: 0,
        stGid: 0,
        stSize: 1,
        stAtime: 0,
        stMtime: 0,
        stCtime: 0,
      })) as unknown as Kaos['stat'],
    });
    const tree = await listDirectory(kaos, '/w');
    expect(tree).toMatch(/\.\.\. and 20 more entries/);
  });

  it('returns [not readable] when the root directory itself is inaccessible', async () => {
    const kaos = createFakeKaos({
      iterdir: (async function* (_p: string) {
        throw new Error('EACCES');
        // eslint-disable-next-line no-unreachable
        yield '';
      }) as unknown as Kaos['iterdir'],
    } as Parameters<typeof createFakeKaos>[0]);
    const result = await listDirectory(kaos, '/no-access');
    expect(result).toBe('[not readable]');
  });

  it('shows [not readable] for inaccessible subdirectory', async () => {
    const kaos = createFakeKaos({
      iterdir: (async function* (p: string) {
        if (p === '/w') {
          yield '/w/locked';
        } else {
          throw new Error('EACCES');
        }
      }) as unknown as Kaos['iterdir'],
      stat: (async () => ({
        stMode: 0o040_000,
        stIno: 1,
        stDev: 1,
        stNlink: 1,
        stUid: 0,
        stGid: 0,
        stSize: 1,
        stAtime: 0,
        stMtime: 0,
        stCtime: 0,
      })) as unknown as Kaos['stat'],
    });
    const tree = await listDirectory(kaos, '/w');
    expect(tree).toContain('locked/');
    expect(tree).toContain('[not readable]');
  });
});
