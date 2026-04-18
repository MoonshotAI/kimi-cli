/**
 * Phase 21 §D.3 — `/changelog` helpers.
 *
 * `CHANGELOG.md` lives at the monorepo root (`ts/CHANGELOG.md`) so this
 * module walks up from the compiled file location looking for a file
 * named `CHANGELOG.md`. Once located, the latest `## ...` section is
 * extracted and printed — everything from the first `## ` line to just
 * before the next `## ` line (or EOF).
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Parse the most recent `## ...` section out of a CHANGELOG.md body.
 * Returns `null` when the content has no `## ` heading.
 *
 * The returned string includes the `## ...` header line and stops
 * before the next `## ` heading (or EOF). Trailing whitespace is
 * trimmed so consecutive blank lines before the next section do not
 * pad the output.
 */
export function parseLatestChangelogSection(content: string): string | null {
  const lines = content.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.startsWith('## ')) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j += 1) {
    if (lines[j]!.startsWith('## ')) {
      end = j;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trimEnd();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * Walk up from `startDir` looking for `CHANGELOG.md`. Returns the
 * absolute path when found, `null` otherwise. Bounded by filesystem
 * root so a missing CHANGELOG.md does not loop forever.
 */
export async function findChangelogPath(startDir: string): Promise<string | null> {
  let dir = resolve(startDir);
  // Hard cap in case `dirname('/')` ever returns something other than
  // `/` (it does on Windows with drive roots — the loop still
  // terminates when the directory stops changing).
  for (let depth = 0; depth < 32; depth += 1) {
    const candidate = join(dir, 'CHANGELOG.md');
    if (await fileExists(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export interface LoadChangelogDeps {
  readonly startDir: string;
  readonly readFile?: (path: string) => Promise<string>;
  readonly findPath?: (startDir: string) => Promise<string | null>;
}

/**
 * Load and return the latest changelog section. Deps are injectable so
 * tests can stub the filesystem cheaply.
 */
export async function loadLatestChangelog(
  deps: LoadChangelogDeps,
): Promise<{ ok: true; section: string } | { ok: false; message: string }> {
  const findPath = deps.findPath ?? findChangelogPath;
  const read = deps.readFile ?? ((p: string) => readFile(p, 'utf-8'));
  const path = await findPath(deps.startDir);
  if (path === null) {
    return { ok: false, message: 'No CHANGELOG.md found.' };
  }
  const content = await read(path);
  const section = parseLatestChangelogSection(content);
  if (section === null) {
    return { ok: false, message: `CHANGELOG.md at ${path} has no sections.` };
  }
  return { ok: true, section };
}
