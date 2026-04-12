import { describe, expect, it } from 'vitest';

import { getCurrentKaos, runWithKaos } from '../../src/current.js';
import type { Kaos } from '../../src/kaos.js';
import { LocalKaos } from '../../src/local.js';

// ── Mock Kaos ─────────────────────────────────────────────────────────

function createNamedKaos(kaosName: string): Kaos {
  const base = new LocalKaos();
  return {
    name: kaosName,
    pathClass: () => base.pathClass(),
    normpath: (p: string) => base.normpath(p),
    gethome: () => base.gethome(),
    getcwd: () => base.getcwd(),
    chdir: async (p: string) => base.chdir(p),
    stat: async (p: string, opts?: { followSymlinks?: boolean }) => base.stat(p, opts),
    iterdir: (p: string) => base.iterdir(p),
    glob: (p: string, pattern: string, opts?: { caseSensitive?: boolean }) =>
      base.glob(p, pattern, opts),
    readBytes: async (p: string, n?: number) => base.readBytes(p, n),
    readText: async (
      p: string,
      opts?: { encoding?: BufferEncoding; errors?: 'strict' | 'ignore' | 'replace' },
    ) => base.readText(p, opts),
    readLines: (p: string, opts?: { encoding?: BufferEncoding }) => base.readLines(p, opts),
    writeBytes: async (p: string, data: Buffer) => base.writeBytes(p, data),
    writeText: async (
      p: string,
      data: string,
      opts?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
    ) => base.writeText(p, data, opts),
    mkdir: async (p: string, opts?: { parents?: boolean; existOk?: boolean }) =>
      base.mkdir(p, opts),
    exec: async (...args: string[]) => base.exec(...args),
    execWithEnv: async (args: string[], env?: Record<string, string>) =>
      base.execWithEnv(args, env),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('e2e: async isolation (AsyncLocalStorage)', () => {
  describe('runWithKaos provides true isolation between concurrent calls', () => {
    it('two concurrent runWithKaos with different Kaos instances return correct instances', async () => {
      const kaosA = createNamedKaos('kaos-A');
      const kaosB = createNamedKaos('kaos-B');

      const [nameA, nameB] = await Promise.all([
        runWithKaos(kaosA, async () => {
          // Yield the event loop to let B start
          await delay(5);
          return getCurrentKaos().name;
        }),
        runWithKaos(kaosB, async () => {
          // Yield the event loop to let A continue
          await delay(5);
          return getCurrentKaos().name;
        }),
      ]);

      expect(nameA).toBe('kaos-A');
      expect(nameB).toBe('kaos-B');
    });

    it('many concurrent runWithKaos calls maintain isolation', async () => {
      const count = 20;
      const results = await Promise.all(
        Array.from({ length: count }, (_, i) => {
          const kaos = createNamedKaos(`kaos-${i}`);
          return runWithKaos(kaos, async () => {
            await delay(Math.random() * 10);
            return getCurrentKaos().name;
          });
        }),
      );

      for (let i = 0; i < count; i++) {
        expect(results[i]).toBe(`kaos-${i}`);
      }
    });
  });

  describe('nested runWithKaos', () => {
    it('inner scope sees inner Kaos, outer scope restores after exit', async () => {
      const kaosOuter = createNamedKaos('outer');
      const kaosInner = createNamedKaos('inner');

      const result = await runWithKaos(kaosOuter, async () => {
        const beforeNest = getCurrentKaos().name;

        const innerResult = await runWithKaos(kaosInner, async () => {
          return getCurrentKaos().name;
        });

        const afterNest = getCurrentKaos().name;

        return { beforeNest, innerResult, afterNest };
      });

      expect(result.beforeNest).toBe('outer');
      expect(result.innerResult).toBe('inner');
      expect(result.afterNest).toBe('outer');
    });

    it('triple nested runWithKaos restores correctly at each level', async () => {
      const kaosA = createNamedKaos('level-A');
      const kaosB = createNamedKaos('level-B');
      const kaosC = createNamedKaos('level-C');

      const result = await runWithKaos(kaosA, async () => {
        const atA = getCurrentKaos().name;

        const inner = await runWithKaos(kaosB, async () => {
          const atB = getCurrentKaos().name;

          const deepest = await runWithKaos(kaosC, async () => {
            return getCurrentKaos().name;
          });

          const afterC = getCurrentKaos().name;
          return { atB, deepest, afterC };
        });

        const afterB = getCurrentKaos().name;
        return { atA, ...inner, afterB };
      });

      expect(result.atA).toBe('level-A');
      expect(result.atB).toBe('level-B');
      expect(result.deepest).toBe('level-C');
      expect(result.afterC).toBe('level-B');
      expect(result.afterB).toBe('level-A');
    });
  });

  describe('runWithKaos context survives await', () => {
    it('context is maintained after await delay', async () => {
      const kaos = createNamedKaos('awaited');

      const result = await runWithKaos(kaos, async () => {
        const before = getCurrentKaos().name;
        await delay(10);
        const after = getCurrentKaos().name;
        return { before, after };
      });

      expect(result.before).toBe('awaited');
      expect(result.after).toBe('awaited');
    });

    it('context is maintained across multiple awaits', async () => {
      const kaos = createNamedKaos('multi-await');

      const result = await runWithKaos(kaos, async () => {
        const names: string[] = [];
        for (let i = 0; i < 5; i++) {
          await delay(2);
          names.push(getCurrentKaos().name);
        }
        return names;
      });

      expect(result).toEqual([
        'multi-await',
        'multi-await',
        'multi-await',
        'multi-await',
        'multi-await',
      ]);
    });

    it('context survives Promise.all inside runWithKaos', async () => {
      const kaos = createNamedKaos('promise-all');

      const result = await runWithKaos(kaos, async () => {
        const names = await Promise.all([
          (async () => {
            await delay(5);
            return getCurrentKaos().name;
          })(),
          (async () => {
            await delay(10);
            return getCurrentKaos().name;
          })(),
          (async () => {
            await delay(1);
            return getCurrentKaos().name;
          })(),
        ]);
        return names;
      });

      expect(result).toEqual(['promise-all', 'promise-all', 'promise-all']);
    });
  });
});
