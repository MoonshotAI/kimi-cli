/**
 * Path safety guards — ports Python `kimi_cli/utils/path.py:158-182`
 * and the guard wired into Read/Write/Edit/Grep/Glob.
 *
 * Canonicalization is **lexical** only (no `realpath` / symlink following).
 * This mirrors Python's `KaosPath.canonical()` and keeps the guard
 * kaos-agnostic — it must give the same answer whether the underlying
 * Kaos is LocalKaos or SSHKaos.
 *
 * Python commit 5eae790d fixed a shared-prefix escape (`/workspace-evil`
 * passing a `startswith('/workspace')` check). We emulate the fix by
 * requiring a path separator (or exact equality) after the base prefix
 * in `isWithinDirectory`.
 */

import { isAbsolute, normalize, resolve, sep } from 'node:path';

import { isSensitiveFile } from './sensitive.js';
import type { WorkspaceConfig } from './workspace.js';

export type PathSecurityCode = 'PATH_OUTSIDE_WORKSPACE' | 'PATH_SENSITIVE' | 'PATH_INVALID';

export class PathSecurityError extends Error {
  readonly code: PathSecurityCode;
  readonly rawPath: string;
  readonly canonicalPath: string;

  constructor(code: PathSecurityCode, rawPath: string, canonicalPath: string, message: string) {
    super(message);
    this.name = 'PathSecurityError';
    this.code = code;
    this.rawPath = rawPath;
    this.canonicalPath = canonicalPath;
  }
}

/**
 * Lexical canonicalization: resolve relative → absolute against `cwd`,
 * then normalize `..` / `.` segments. No filesystem I/O.
 */
export function canonicalizePath(path: string, cwd: string): string {
  if (path === '') {
    throw new PathSecurityError('PATH_INVALID', path, path, 'Path cannot be empty');
  }
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  return normalize(abs);
}

/**
 * True iff `candidate` is `base` itself or a descendant of it, compared
 * on path-component boundaries. Both arguments must already be canonical.
 */
export function isWithinDirectory(candidate: string, base: string): boolean {
  if (candidate === base) return true;
  const prefix = base.endsWith(sep) ? base : base + sep;
  return candidate.startsWith(prefix);
}

/**
 * True iff `candidate` (already canonical) sits inside any of the workspace
 * roots listed in `config` (primary `workspaceDir` or any `additionalDirs`).
 */
export function isWithinWorkspace(candidate: string, config: WorkspaceConfig): boolean {
  if (isWithinDirectory(candidate, config.workspaceDir)) return true;
  for (const dir of config.additionalDirs) {
    if (isWithinDirectory(candidate, dir)) return true;
  }
  return false;
}

export interface AssertPathOptions {
  readonly mode: 'read' | 'write' | 'search';
  /** When true (default), also reject paths matching a sensitive-file pattern. */
  readonly checkSensitive?: boolean | undefined;
}

/**
 * Throw `PathSecurityError` if `path` is outside the workspace, a known
 * sensitive file, or an empty string. Returns the canonical absolute path
 * when the check passes.
 *
 * Note: this is purely lexical. It does NOT protect against symlink
 * targets that point outside the workspace — that requires kaos-layer
 * realpath support and is deferred to Phase 2 (PHASE2 §8).
 */
export function assertPathAllowed(
  path: string,
  cwd: string,
  config: WorkspaceConfig,
  options: AssertPathOptions,
): string {
  const canonical = canonicalizePath(path, cwd);

  const checkSensitive = options.checkSensitive ?? true;
  if (checkSensitive && isSensitiveFile(canonical)) {
    throw new PathSecurityError(
      'PATH_SENSITIVE',
      path,
      canonical,
      `"${path}" matches a sensitive-file pattern (env / credential / SSH key). ` +
        `Access is blocked to protect secrets.`,
    );
  }

  if (!isWithinWorkspace(canonical, config)) {
    const allowed = [config.workspaceDir, ...config.additionalDirs].join(', ');
    const verb =
      options.mode === 'write' ? 'written' : options.mode === 'search' ? 'searched' : 'read';
    throw new PathSecurityError(
      'PATH_OUTSIDE_WORKSPACE',
      path,
      canonical,
      `"${path}" (canonical: "${canonical}") is outside the workspace and ` +
        `cannot be ${verb}. Allowed roots: ${allowed}`,
    );
  }

  return canonical;
}
