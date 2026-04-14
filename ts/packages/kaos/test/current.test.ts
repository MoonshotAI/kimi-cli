import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import {
  chdir,
  exec,
  execWithEnv,
  getCurrentKaos,
  gethome,
  getcwd,
  glob,
  iterdir,
  LocalKaos,
  mkdir,
  normpath,
  pathClass,
  readBytes,
  readLines,
  readText,
  resetCurrentKaos,
  setCurrentKaos,
  stat,
  writeBytes,
  writeText,
} from '../src/index.js';
import type { Kaos, KaosToken } from '../src/index.js';

function createMockKaos(name: string): Kaos {
  return {
    name,
    pathClass: () => 'posix' as const,
    normpath: (p: string) => p,
    gethome: () => '/',
    getcwd: () => '/',
    chdir: async () => {},
    stat: () =>
      Promise.resolve({
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
      }),
    iterdir: async function* () {},
    glob: async function* () {},
    readBytes: () => Promise.resolve(Buffer.alloc(0)),
    readText: () => Promise.resolve(''),
    readLines: async function* () {},
    writeBytes: () => Promise.resolve(0),
    writeText: () => Promise.resolve(0),
    mkdir: () => Promise.resolve(),
    exec: () =>
      Promise.resolve({
        stdin: null as unknown as Writable,
        stdout: null as unknown as Readable,
        stderr: null as unknown as Readable,
        pid: -1,
        exitCode: 0,
        wait: () => Promise.resolve(0),
        kill: () => Promise.resolve(),
      }),
    execWithEnv: () =>
      Promise.resolve({
        stdin: null as unknown as Writable,
        stdout: null as unknown as Readable,
        stderr: null as unknown as Readable,
        pid: -1,
        exitCode: 0,
        wait: () => Promise.resolve(0),
        kill: () => Promise.resolve(),
      }),
  };
}

describe('current kaos context', () => {
  let token: KaosToken | undefined;

  afterEach(() => {
    if (token !== undefined) {
      resetCurrentKaos(token);
      token = undefined;
    }
  });

  it('should return a LocalKaos instance by default', () => {
    const kaos = getCurrentKaos();
    expect(kaos).toBeInstanceOf(LocalKaos);
    expect(kaos.name).toBe('local');
  });

  it('should return a token from setCurrentKaos', () => {
    const original = getCurrentKaos();
    token = setCurrentKaos(new LocalKaos());
    expect(token.previousKaos).toBe(original);
  });

  it('should allow setting a custom kaos instance', () => {
    const mockKaos = createMockKaos('mock');
    token = setCurrentKaos(mockKaos);
    const current = getCurrentKaos();
    expect(current.name).toBe('mock');
    expect(current).toBe(mockKaos);
  });

  it('should restore previous kaos with resetCurrentKaos', () => {
    const original = getCurrentKaos();
    token = setCurrentKaos(new LocalKaos());
    expect(getCurrentKaos()).not.toBe(original);
    resetCurrentKaos(token);
    expect(getCurrentKaos()).toBe(original);
    // already restored
    token = undefined;
  });

  it('should support nested set/reset', () => {
    const original = getCurrentKaos();

    const first = new LocalKaos();
    const token1 = setCurrentKaos(first);
    expect(getCurrentKaos()).toBe(first);

    const second = new LocalKaos();
    const token2 = setCurrentKaos(second);
    expect(getCurrentKaos()).toBe(second);

    resetCurrentKaos(token2);
    expect(getCurrentKaos()).toBe(first);

    resetCurrentKaos(token1);
    expect(getCurrentKaos()).toBe(original);
  });

  it('isolates set/reset across concurrent async flows', async () => {
    const kaosA = createMockKaos('A');
    const kaosB = createMockKaos('B');

    const [seenA, seenB] = await Promise.all([
      (async () => {
        const tokenA = setCurrentKaos(kaosA);
        try {
          await Promise.resolve();
          await new Promise((resolve) => {
            setTimeout(resolve, 20);
          });
          return getCurrentKaos().name;
        } finally {
          resetCurrentKaos(tokenA);
        }
      })(),
      (async () => {
        const tokenB = setCurrentKaos(kaosB);
        try {
          await Promise.resolve();
          await new Promise((resolve) => {
            setTimeout(resolve, 5);
          });
          return getCurrentKaos().name;
        } finally {
          resetCurrentKaos(tokenB);
        }
      })(),
    ]);

    expect(seenA).toBe('A');
    expect(seenB).toBe('B');
  });
});

describe('module-level proxy functions', () => {
  it('normpath delegates to the current kaos instance', () => {
    // LocalKaos on posix normalizes '/foo/../bar' to '/bar'
    const result = normpath('/foo/../bar');
    expect(typeof result).toBe('string');
    expect(result.endsWith('bar')).toBe(true);
  });

  it('pathClass returns posix or win32 from the current kaos', () => {
    const result = pathClass();
    expect(result === 'posix' || result === 'win32').toBe(true);
  });

  it('readLines proxies to the current kaos and yields lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kaos-readlines-'));
    try {
      const filePath = join(dir, 'lines.txt');
      await writeText(filePath, 'alpha\nbravo\ncharlie');
      const collected: string[] = [];
      for await (const line of readLines(filePath)) {
        collected.push(line);
      }
      // readLines preserves newline terminators on each line.
      expect(collected).toEqual(['alpha\n', 'bravo\n', 'charlie']);
      expect(collected.join('')).toBe('alpha\nbravo\ncharlie');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writeText accepts an encoding option through the module-level proxy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kaos-writetext-enc-'));
    try {
      const filePath = join(dir, 'enc.txt');
      // Pass a non-default encoding to prove the option flows through the
      // proxy signature without a TypeScript error.
      await writeText(filePath, 'hello-latin1', { encoding: 'latin1' });
      const contents = await readText(filePath, { encoding: 'latin1' });
      expect(contents).toBe('hello-latin1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('execWithEnv proxies to the current kaos', async () => {
    // Use the real LocalKaos to run `env | grep CUSTOM_VAR`
    const proc = await execWithEnv(['sh', '-c', 'echo "$CUSTOM_VAR"'], {
      CUSTOM_VAR: 'proxy_test_value',
      // Preserve PATH so sh can be found
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    });

    const chunks: Buffer[] = [];
    for await (const chunk of proc.stdout) {
      chunks.push(chunk as Buffer);
    }
    const stdout = Buffer.concat(chunks).toString('utf-8').trim();
    await proc.wait();

    expect(stdout).toBe('proxy_test_value');
  });

  // These tests pin the remaining module-level facade functions to their
  // `getCurrentKaos()` delegate. Using a spy Kaos lets us assert delegation
  // happened without needing real filesystem I/O for each proxy.
  it('delegates every facade function to the current kaos instance', async () => {
    const calls: string[] = [];
    const spyKaos: Kaos = {
      ...createMockKaos('spy'),
      pathClass: () => {
        calls.push('pathClass');
        return 'posix';
      },
      normpath: (p) => {
        calls.push(`normpath:${p}`);
        return p;
      },
      gethome: () => {
        calls.push('gethome');
        return '/mock-home';
      },
      getcwd: () => {
        calls.push('getcwd');
        return '/mock-cwd';
      },
      chdir: async (p) => {
        calls.push(`chdir:${p}`);
      },
      stat: async (p) => {
        calls.push(`stat:${p}`);
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
      iterdir: async function* (p) {
        calls.push(`iterdir:${p}`);
        // Yield a throwaway value so this function is a valid non-empty
        // generator — the test just wants to observe that the push ran.
        yield `${p}/dummy`;
      },
      glob: async function* (p, pat) {
        calls.push(`glob:${p}:${pat}`);
        yield `${p}/${pat}`;
      },
      readBytes: async (p, n) => {
        calls.push(`readBytes:${p}:${String(n)}`);
        return Buffer.alloc(0);
      },
      readText: async (p) => {
        calls.push(`readText:${p}`);
        return '';
      },
      readLines: async function* (p) {
        calls.push(`readLines:${p}`);
        yield `${p}:line`;
      },
      writeBytes: async (p, d) => {
        calls.push(`writeBytes:${p}:${String(d.length)}`);
        return d.length;
      },
      writeText: async (p, d) => {
        calls.push(`writeText:${p}:${String(d.length)}`);
        return d.length;
      },
      mkdir: async (p) => {
        calls.push(`mkdir:${p}`);
      },
    };

    const spyToken = setCurrentKaos(spyKaos);
    try {
      // Sync proxies
      expect(pathClass()).toBe('posix');
      expect(normpath('/a/b')).toBe('/a/b');
      expect(gethome()).toBe('/mock-home');
      expect(getcwd()).toBe('/mock-cwd');

      // Async single-value proxies
      await chdir('/dst');
      await stat('/path');
      await readBytes('/f', 10);
      await readText('/f2');
      await writeBytes('/f3', Buffer.from([1, 2, 3]));
      await writeText('/f4', 'hello');
      await mkdir('/d');

      // Async-generator proxies — must be consumed to execute body
      for await (const _ of iterdir('/d2')) {
        // body intentionally empty
        void _;
      }
      for await (const _ of glob('/d3', '*.txt')) {
        void _;
      }
    } finally {
      resetCurrentKaos(spyToken);
    }

    expect(calls).toEqual([
      'pathClass',
      'normpath:/a/b',
      'gethome',
      'getcwd',
      'chdir:/dst',
      'stat:/path',
      'readBytes:/f:10',
      'readText:/f2',
      'writeBytes:/f3:3',
      'writeText:/f4:5',
      'mkdir:/d',
      'iterdir:/d2',
      'glob:/d3:*.txt',
    ]);
  });

  it('exec proxies to the current kaos instance', async () => {
    let received: string[] = [];
    const spyKaos: Kaos = {
      ...createMockKaos('spy-exec'),
      exec: async (...args) => {
        received = args;
        throw new Error('intentionally stopped for the spy');
      },
    };

    const spyToken = setCurrentKaos(spyKaos);
    try {
      await expect(exec('cmd', 'a', 'b')).rejects.toThrow('intentionally stopped for the spy');
    } finally {
      resetCurrentKaos(spyToken);
    }
    expect(received).toEqual(['cmd', 'a', 'b']);
  });
});

describe('resetCurrentKaos null-token fallback', () => {
  it('falls back to the default LocalKaos when previousKaos is null', () => {
    // Construct a synthetic token whose previousKaos is null. This mirrors
    // the state a token would be in if the ambient context had no override
    // at all when `setCurrentKaos` was called.
    const syntheticToken: KaosToken = { previousKaos: null };
    resetCurrentKaos(syntheticToken);

    // After reset, the current kaos should be the default LocalKaos.
    const current = getCurrentKaos();
    expect(current.name).toBe('local');
  });
});
