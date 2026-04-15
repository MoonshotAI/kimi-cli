/**
 * Fake Kaos — minimal stub for tool constructor injection in tests.
 *
 * All methods throw by default. Individual tests can override specific
 * methods with vi.fn() to provide scripted responses for the tool
 * under test.
 */

import type { Kaos } from '@moonshot-ai/kaos';

function notImplemented(method: string): never {
  throw new Error(`FakeKaos.${method} not implemented — override in test`);
}

export function createFakeKaos(overrides?: Partial<Kaos>): Kaos {
  const base: Kaos = {
    name: 'fake',
    pathClass: () => 'posix',
    normpath: (p: string) => p,
    gethome: () => '/home/test',
    getcwd: () => '/workspace',
    chdir: () => notImplemented('chdir'),
    stat: () => notImplemented('stat'),
    iterdir: () => notImplemented('iterdir'),
    glob: () => notImplemented('glob'),
    readBytes: () => notImplemented('readBytes'),
    readText: () => notImplemented('readText'),
    readLines: () => notImplemented('readLines'),
    writeBytes: () => notImplemented('writeBytes'),
    writeText: () => notImplemented('writeText'),
    mkdir: () => notImplemented('mkdir'),
    exec: () => notImplemented('exec'),
    execWithEnv: () => notImplemented('execWithEnv'),
  };
  return { ...base, ...overrides } as Kaos;
}
