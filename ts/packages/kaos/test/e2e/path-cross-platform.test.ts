import { describe, expect, it } from 'vitest';

import { getCurrentKaos, runWithKaos } from '../../src/current.js';
import type { Kaos } from '../../src/kaos.js';
import { KaosPath } from '../../src/path.js';
import type { KaosProcess } from '../../src/process.js';
import type { StatResult } from '../../src/types.js';

// ── Minimal mock Kaos ────────────────────────────────────────────────

function createMockKaos(overrides: Partial<Kaos> & { name: string }): Kaos {
  const defaults: Kaos = {
    name: overrides.name,
    pathClass(): 'posix' | 'win32' {
      return 'posix';
    },
    normpath(path: string): string {
      return path;
    },
    gethome(): string {
      return '/default/home';
    },
    getcwd(): string {
      return '/default/cwd';
    },
    async chdir(): Promise<void> {
      // no-op
    },
    async stat(): Promise<StatResult> {
      return {
        stMode: 0,
        stIno: 0,
        stDev: 0,
        stNlink: 0,
        stUid: 0,
        stGid: 0,
        stSize: 0,
        stAtime: 0,
        stMtime: 0,
        stCtime: 0,
      };
    },
    async *iterdir(): AsyncGenerator<string> {
      // empty
    },
    async *glob(): AsyncGenerator<string> {
      // empty
    },
    async readBytes(): Promise<Buffer> {
      return Buffer.alloc(0);
    },
    async readText(): Promise<string> {
      return '';
    },
    async *readLines(): AsyncGenerator<string> {
      // empty
    },
    async writeBytes(): Promise<number> {
      return 0;
    },
    async writeText(): Promise<number> {
      return 0;
    },
    async mkdir(): Promise<void> {
      // no-op
    },
    async exec(): Promise<KaosProcess> {
      throw new Error('Not implemented');
    },
    async execWithEnv(): Promise<KaosProcess> {
      throw new Error('Not implemented');
    },
  };

  return { ...defaults, ...overrides };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('e2e: KaosPath cross-platform', () => {
  describe('expanduser delegates to kaos.gethome()', () => {
    it('~ expands to custom home from mock Kaos', () => {
      const mockKaos = createMockKaos({
        name: 'custom-home',
        gethome(): string {
          return '/custom/home';
        },
      });

      const result = runWithKaos(mockKaos, () => {
        return new KaosPath('~').expanduser().toString();
      });

      expect(result).toBe('/custom/home');
    });

    it('~/subpath expands correctly', () => {
      const mockKaos = createMockKaos({
        name: 'custom-home-sub',
        gethome(): string {
          return '/users/testuser';
        },
      });

      const result = runWithKaos(mockKaos, () => {
        return new KaosPath('~/Documents/file.txt').expanduser().toString();
      });

      expect(result).toBe('/users/testuser/Documents/file.txt');
    });

    it('non-tilde path is unchanged', () => {
      const mockKaos = createMockKaos({
        name: 'no-expand',
        gethome(): string {
          return '/should/not/appear';
        },
      });

      const result = runWithKaos(mockKaos, () => {
        return new KaosPath('/absolute/path').expanduser().toString();
      });

      expect(result).toBe('/absolute/path');
    });
  });

  describe('canonical uses correct path module', () => {
    it('posix pathClass uses posix rules', () => {
      const mockKaos = createMockKaos({
        name: 'posix-canonical',
        pathClass(): 'posix' | 'win32' {
          return 'posix';
        },
        getcwd(): string {
          return '/home/user/project';
        },
      });

      const result = runWithKaos(mockKaos, () => {
        return new KaosPath('src/../lib/utils.ts').canonical().toString();
      });

      // posix normalize of /home/user/project/src/../lib/utils.ts
      expect(result).toBe('/home/user/project/lib/utils.ts');
    });

    it('absolute path is normalized without prepending cwd', () => {
      const mockKaos = createMockKaos({
        name: 'abs-canonical',
        pathClass(): 'posix' | 'win32' {
          return 'posix';
        },
        getcwd(): string {
          return '/should/not/appear';
        },
      });

      const result = runWithKaos(mockKaos, () => {
        return new KaosPath('/a/b/../c/./d').canonical().toString();
      });

      expect(result).toBe('/a/c/d');
    });

    it('relative path is resolved against cwd', () => {
      const mockKaos = createMockKaos({
        name: 'rel-canonical',
        pathClass(): 'posix' | 'win32' {
          return 'posix';
        },
        getcwd(): string {
          return '/workspace';
        },
      });

      const result = runWithKaos(mockKaos, () => {
        return new KaosPath('src/main.ts').canonical().toString();
      });

      expect(result).toBe('/workspace/src/main.ts');
    });
  });

  describe('runWithKaos concurrent isolation', () => {
    it('concurrent runWithKaos calls return their own Kaos instances', async () => {
      const kaos1 = createMockKaos({
        name: 'kaos-1',
        gethome(): string {
          return '/home/user1';
        },
      });

      const kaos2 = createMockKaos({
        name: 'kaos-2',
        gethome(): string {
          return '/home/user2';
        },
      });

      const results = await Promise.all([
        new Promise<{ name: string; home: string }>((resolve) => {
          runWithKaos(kaos1, () => {
            // Small delay to ensure overlap
            setTimeout(() => {
              const current = getCurrentKaos();
              resolve({
                name: current.name,
                home: current.gethome(),
              });
            }, 10);
          });
        }),
        new Promise<{ name: string; home: string }>((resolve) => {
          runWithKaos(kaos2, () => {
            setTimeout(() => {
              const current = getCurrentKaos();
              resolve({
                name: current.name,
                home: current.gethome(),
              });
            }, 10);
          });
        }),
      ]);

      expect(results[0].name).toBe('kaos-1');
      expect(results[0].home).toBe('/home/user1');
      expect(results[1].name).toBe('kaos-2');
      expect(results[1].home).toBe('/home/user2');
    });

    it('nested runWithKaos scopes correctly', () => {
      const outerKaos = createMockKaos({
        name: 'outer',
        gethome(): string {
          return '/outer/home';
        },
      });

      const innerKaos = createMockKaos({
        name: 'inner',
        gethome(): string {
          return '/inner/home';
        },
      });

      const outerHome = runWithKaos(outerKaos, () => {
        const before = getCurrentKaos().gethome();

        const innerHome = runWithKaos(innerKaos, () => {
          return getCurrentKaos().gethome();
        });

        const after = getCurrentKaos().gethome();

        return { before, innerHome, after };
      });

      expect(outerHome.before).toBe('/outer/home');
      expect(outerHome.innerHome).toBe('/inner/home');
      expect(outerHome.after).toBe('/outer/home');
    });
  });

  describe('KaosPath static methods via mock', () => {
    it('KaosPath.home() delegates to getCurrentKaos', () => {
      const mockKaos = createMockKaos({
        name: 'static-home',
        gethome(): string {
          return '/mock/home/dir';
        },
      });

      const result = runWithKaos(mockKaos, () => {
        return KaosPath.home().toString();
      });

      expect(result).toBe('/mock/home/dir');
    });

    it('KaosPath.cwd() delegates to getCurrentKaos', () => {
      const mockKaos = createMockKaos({
        name: 'static-cwd',
        getcwd(): string {
          return '/mock/working/dir';
        },
      });

      const result = runWithKaos(mockKaos, () => {
        return KaosPath.cwd().toString();
      });

      expect(result).toBe('/mock/working/dir');
    });
  });
});
