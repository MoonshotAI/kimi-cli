/**
 * Environment — cross-platform probe of OS / shell (Phase 14 §1.2).
 *
 * Ports Python `src/kimi_cli/utils/environment.py:11-73`. The detection
 * function is a pure function of injected probes (`platform` / `arch` /
 * `release` / `env` / `isFile`) so the same suite runs identically on any
 * host OS. `detectEnvironmentFromNode()` bundles the Node defaults for
 * production callers.
 */

import { access } from 'node:fs/promises';
import * as nodeOs from 'node:os';
import { constants as fsConstants } from 'node:fs';

// `OsKind` carries 'macOS' / 'Linux' / 'Windows' for known platforms and
// falls back to the raw `process.platform` string for unknown ones (e.g.
// 'freebsd'). Typed as `string` so the union isn't inhabited-by-string.
export type OsKind = string;
export type ShellName = 'bash' | 'sh' | 'Windows PowerShell';

export interface Environment {
  readonly osKind: OsKind;
  readonly osArch: string;
  readonly osVersion: string;
  readonly shellName: ShellName;
  readonly shellPath: string;
}

export interface EnvironmentDeps {
  // Accepts the full Node `Platform` enum plus arbitrary strings for
  // forward-compatible OS kinds.
  readonly platform: string;
  readonly arch: string;
  readonly release: string;
  readonly env: Record<string, string | undefined>;
  readonly isFile: (path: string) => Promise<boolean>;
}

function resolveOsKind(platform: string): OsKind {
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    case 'win32':
      return 'Windows';
    default:
      return platform;
  }
}

export async function detectEnvironment(deps: EnvironmentDeps): Promise<Environment> {
  const osKind = resolveOsKind(deps.platform);
  const osArch = deps.arch;
  const osVersion = deps.release;

  let shellName: ShellName;
  let shellPath: string;

  if (deps.platform === 'win32') {
    shellName = 'Windows PowerShell';
    const systemRoot = deps.env['SYSTEMROOT'] ?? 'C:\\Windows';
    const candidate = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    shellPath = (await deps.isFile(candidate)) ? candidate : 'powershell.exe';
  } else {
    const candidates: readonly string[] = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'];
    let found: string | undefined;
    for (const p of candidates) {
      if (await deps.isFile(p)) {
        found = p;
        break;
      }
    }
    if (found !== undefined) {
      shellName = 'bash';
      shellPath = found;
    } else {
      shellName = 'sh';
      shellPath = '/bin/sh';
    }
  }

  return { osKind, osArch, osVersion, shellName, shellPath };
}

/**
 * Production convenience — derive the deps bag from Node's ambient surface.
 */
export async function detectEnvironmentFromNode(): Promise<Environment> {
  return detectEnvironment({
    platform: process.platform,
    arch: process.arch,
    release: nodeOs.release(),
    env: process.env as Record<string, string | undefined>,
    isFile: async (path: string): Promise<boolean> => {
      try {
        await access(path, fsConstants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
  });
}
