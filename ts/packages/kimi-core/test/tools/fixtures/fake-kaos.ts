/**
 * Fake Kaos — minimal stub for tool constructor injection in tests.
 *
 * All methods throw by default. Individual tests can override specific
 * methods with vi.fn() to provide scripted responses for the tool
 * under test.
 *
 * Also provides `PERMISSIVE_WORKSPACE` (`/` as workspaceDir) — most tool
 * tests care about behaviour, not path safety, so they default to a
 * workspace that accepts any absolute path. Attack-vector tests create
 * their own `WorkspaceConfig` with narrower bounds.
 */

import type { Kaos } from '@moonshot-ai/kaos';

import type { ToolResult } from '../../../src/soul/types.js';
import type { WorkspaceConfig } from '../../../src/tools/index.js';

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

export const PERMISSIVE_WORKSPACE: WorkspaceConfig = {
  workspaceDir: '/',
  additionalDirs: [],
};

/**
 * Assert that a `ToolResult`'s `content` is a string and return it.
 * Keeps the lint rule `typescript-eslint(no-base-to-string)` happy by
 * narrowing the `string | ToolResultContent[]` union in one place.
 */
export function toolContentString(result: ToolResult): string {
  const c = result.content;
  if (typeof c !== 'string') {
    throw new TypeError(`expected string content, got ${typeof c}`);
  }
  return c;
}
