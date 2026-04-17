/**
 * Environment detection — Phase 14 §1.2 / §1.5.
 *
 * Ports Python `src/kimi_cli/utils/environment.py:11-73`. These tests
 * pin the cross-platform shape of `detectEnvironment()`:
 *
 *   - macOS / Linux / Windows / unknown → `osKind`
 *   - POSIX path probing prefers /bin/bash, falls back to /usr/bin/bash,
 *     /usr/local/bin/bash, then /bin/sh (with shellName 'sh').
 *   - Windows resolves `${SYSTEMROOT}/System32/WindowsPowerShell/v1.0/powershell.exe`
 *     first, else the `powershell.exe` fallback.
 *   - `osArch` / `osVersion` are populated from the Node OS APIs.
 *
 * All tests expect `detectEnvironment()` to be a pure function of
 * injected platform probes (no ambient state) so the same suite runs
 * identically on macOS/Linux/Windows CI runners.
 *
 * FAILS until `src/utils/environment.ts` is implemented (Phase 14 §1.2).
 */

import { describe, expect, it } from 'vitest';

// Will fail to import until the module is created.
// eslint-disable-next-line import/no-unresolved
import {
  detectEnvironment,
  type Environment,
  type OsKind,
  type ShellName,
} from '../../src/utils/environment.js';

interface StubOpts {
  readonly platform: NodeJS.Platform;
  readonly arch?: string;
  readonly release?: string;
  readonly env?: Record<string, string | undefined>;
  readonly existingPaths?: readonly string[];
}

/** Build a stub deps bag mimicking Node's `os` + `process` surface. */
function stubDeps(opts: StubOpts): Parameters<typeof detectEnvironment>[0] {
  const existing = new Set(opts.existingPaths ?? []);
  return {
    platform: opts.platform,
    arch: opts.arch ?? 'x86_64',
    release: opts.release ?? '1.2.3',
    env: opts.env ?? {},
    isFile: async (path: string) => existing.has(path),
  };
}

describe('detectEnvironment (Phase 14 §1.2)', () => {
  it('reports osKind "macOS" on darwin', async () => {
    const env: Environment = await detectEnvironment(
      stubDeps({
        platform: 'darwin',
        arch: 'arm64',
        release: '23.4.0',
        existingPaths: ['/bin/bash'],
      }),
    );
    expect(env.osKind satisfies OsKind).toBe('macOS');
    expect(env.osArch).toBe('arm64');
    expect(env.osVersion).toBe('23.4.0');
  });

  it('reports osKind "Linux" on linux', async () => {
    const env = await detectEnvironment(
      stubDeps({ platform: 'linux', existingPaths: ['/bin/bash'] }),
    );
    expect(env.osKind).toBe('Linux');
  });

  it('reports osKind "Windows" on win32', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { SYSTEMROOT: 'C:\\Windows' },
        existingPaths: [
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        ],
      }),
    );
    expect(env.osKind).toBe('Windows');
  });

  it('passes through unknown platform string verbatim', async () => {
    const env = await detectEnvironment(
      stubDeps({ platform: 'freebsd' as NodeJS.Platform, existingPaths: ['/bin/sh'] }),
    );
    // Python `Environment.detect` returns `platform.system()` verbatim
    // for unknown OS strings; TS mirrors that behaviour.
    expect(env.osKind).toBe('freebsd');
  });

  // ── POSIX shell probing ────────────────────────────────────────────

  it('prefers /bin/bash when it exists (shellName=bash)', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'linux',
        existingPaths: ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'],
      }),
    );
    expect(env.shellName satisfies ShellName).toBe('bash');
    expect(env.shellPath).toBe('/bin/bash');
  });

  it('falls back to /usr/bin/bash when /bin/bash is missing', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'linux',
        existingPaths: ['/usr/bin/bash', '/usr/local/bin/bash'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('/usr/bin/bash');
  });

  it('falls back to /usr/local/bin/bash when /bin and /usr/bin are missing', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'linux',
        existingPaths: ['/usr/local/bin/bash'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('/usr/local/bin/bash');
  });

  it('falls back to /bin/sh with shellName=sh when no bash is found', async () => {
    const env = await detectEnvironment(
      stubDeps({ platform: 'linux', existingPaths: [] }),
    );
    expect(env.shellName).toBe('sh');
    expect(env.shellPath).toBe('/bin/sh');
  });

  // ── Windows PowerShell probing ─────────────────────────────────────

  it('uses SYSTEMROOT path for powershell when it exists', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { SYSTEMROOT: 'D:\\CustomWin' },
        existingPaths: [
          'D:\\CustomWin\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        ],
      }),
    );
    expect(env.shellName).toBe('Windows PowerShell');
    expect(env.shellPath).toBe(
      'D:\\CustomWin\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
  });

  it('defaults SYSTEMROOT to C:\\Windows when not set', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: {},
        existingPaths: [
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        ],
      }),
    );
    expect(env.shellPath).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
  });

  it('falls back to bare "powershell.exe" when the SYSTEMROOT path is missing', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { SYSTEMROOT: 'C:\\Windows' },
        existingPaths: [],
      }),
    );
    expect(env.shellName).toBe('Windows PowerShell');
    expect(env.shellPath).toBe('powershell.exe');
  });

  // ── arch / version passthrough ─────────────────────────────────────

  it('reports osArch verbatim from the injected probe', async () => {
    const env = await detectEnvironment(
      stubDeps({ platform: 'darwin', arch: 'arm64', existingPaths: ['/bin/bash'] }),
    );
    expect(env.osArch).toBe('arm64');
  });

  it('reports osVersion verbatim from the injected probe', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'linux',
        release: '6.1.0-test',
        existingPaths: ['/bin/bash'],
      }),
    );
    expect(env.osVersion).toBe('6.1.0-test');
  });
});
