import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import {
  execWithEnv,
  getCurrentKaos,
  LocalKaos,
  normpath,
  pathClass,
  readLines,
  readText,
  resetCurrentKaos,
  setCurrentKaos,
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
});
