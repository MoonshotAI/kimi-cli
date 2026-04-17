/**
 * Test environment shim — Phase 9 §3.
 *
 * Python's `Environment` fixture in `tests/conftest.py` is a host-level
 * bag describing the user's OS / shell / cwd, consumed by system-prompt
 * builders and a handful of display helpers. TS-core has no equivalent
 * type, so this helper defines one locally. If / when Phase 10 / 11
 * reveal the need for it, we may promote into src/.
 *
 * See helpers/README.md "Known Gaps" for the current status.
 */

export type TestOsKind = 'macOS' | 'Linux' | 'Windows';

export interface TestEnvironment {
  readonly os: TestOsKind;
  readonly cwd: string;
  readonly shellName: string;
  readonly shellPath: string;
  readonly homeDir: string;
  readonly user: string;
}

export interface CreateTestEnvironmentOptions {
  readonly os?: TestOsKind;
  readonly cwd?: string;
  readonly shellName?: string;
  readonly shellPath?: string;
  readonly homeDir?: string;
  readonly user?: string;
}

const DEFAULTS_BY_OS: Record<TestOsKind, Omit<TestEnvironment, 'os' | 'cwd' | 'homeDir' | 'user'>> = {
  macOS: { shellName: 'zsh', shellPath: '/bin/zsh' },
  Linux: { shellName: 'bash', shellPath: '/bin/bash' },
  Windows: { shellName: 'pwsh', shellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
};

export function createTestEnvironment(
  opts?: CreateTestEnvironmentOptions,
): TestEnvironment {
  const os = opts?.os ?? 'macOS';
  const defaults = DEFAULTS_BY_OS[os];
  return {
    os,
    cwd: opts?.cwd ?? '/workspace',
    shellName: opts?.shellName ?? defaults.shellName,
    shellPath: opts?.shellPath ?? defaults.shellPath,
    homeDir: opts?.homeDir ?? '/home/test',
    user: opts?.user ?? 'test-user',
  };
}
