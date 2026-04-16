/**
 * Git context collection for explore subagents.
 *
 * Python parity: `kimi_cli.subagents.git_context`
 *
 * Provides `collectGitContext()` which gathers repository metadata
 * (remote URL, branch, dirty files, recent commits) and returns a
 * formatted `<git-context>` XML block. Helper functions
 * `parseProjectName()` and `sanitizeRemoteUrl()` are exported for
 * unit testing.
 *
 * Slice 6.0 — full implementation.
 */

import { execFile } from 'node:child_process';

// ── Well-known public hosts (parity with Python `_ALLOWED_HOSTS`) ────

export const ALLOWED_HOSTS: readonly string[] = [
  'github.com',
  'gitlab.com',
  'gitee.com',
  'bitbucket.org',
  'codeberg.org',
  'sr.ht',
];

const TIMEOUT_MS = 5000;
const MAX_DIRTY_FILES = 20;

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Run a single git command and return trimmed stdout, or null on failure.
 * Uses `git -C <cwd>` so the command runs in the specified directory.
 */
function runGit(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(stdout.trim());
      },
    );
    // Defensive: if the child process hangs, the timeout in execFile will kill it.
    void child;
  });
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Extract `owner/repo` from a git remote URL.
 *
 * Supports SSH (`git@host:owner/repo.git`) and HTTPS
 * (`https://host/owner/repo`) formats.
 *
 * Returns `null` for unrecognized formats.
 */
export function parseProjectName(remoteUrl: string): string | null {
  if (!remoteUrl) return null;

  // SSH format: git@host:owner/repo.git
  const sshMatch = /:([^/]+\/[^/]+?)(?:\.git)?$/.exec(remoteUrl);
  if (sshMatch?.[1] !== undefined) {
    return sshMatch[1];
  }

  // HTTPS format: https://host/owner/repo.git
  const httpsMatch = /\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(remoteUrl);
  if (httpsMatch?.[1] !== undefined) {
    return httpsMatch[1];
  }

  return null;
}

/**
 * Sanitize a git remote URL for safe inclusion in context.
 *
 * Returns the URL (with credentials stripped for HTTPS) if the host is
 * in the well-known allowlist. Returns `null` for unrecognized or
 * self-hosted hosts.
 */
export function sanitizeRemoteUrl(remoteUrl: string): string | null {
  // SSH format: git@host:owner/repo.git — no credentials possible
  for (const host of ALLOWED_HOSTS) {
    const pattern = new RegExp(`^git@${escapeRegExp(host)}:`);
    if (pattern.test(remoteUrl)) {
      return remoteUrl;
    }
  }

  // HTTPS format: parse hostname exactly, strip userinfo.
  // Python parity note: Python's urlparse needs an explicit `parsed.port`
  // access to catch malformed ports (e.g. :443.evil). WHATWG URL (used here)
  // throws TypeError on construction for invalid ports, so the catch block
  // covers this case. CRLF injection URLs also throw at construction time.
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return null;
  }

  if (ALLOWED_HOSTS.includes(parsed.hostname)) {
    // Rebuild without userinfo: https://host[:port]/path
    const portPart = parsed.port ? `:${parsed.port}` : '';
    return `https://${parsed.hostname}${portPart}${parsed.pathname}`;
  }

  return null;
}

/**
 * Collect git context information for explore subagents.
 *
 * Returns a formatted `<git-context>` block, or an empty string if the
 * directory is not a git repository or all git commands fail.
 */
export async function collectGitContext(workDir: string): Promise<string> {
  // Quick check: is this a git repo?
  const isGit = await runGit(['rev-parse', '--is-inside-work-tree'], workDir);
  if (isGit === null) {
    return '';
  }

  // Run all git commands in parallel for speed
  const [remoteUrl, branch, dirtyRaw, logRaw] = await Promise.all([
    runGit(['remote', 'get-url', 'origin'], workDir),
    runGit(['branch', '--show-current'], workDir),
    runGit(['status', '--porcelain'], workDir),
    runGit(['log', '-3', '--format=%h %s'], workDir),
  ]);

  const sections: string[] = [`Working directory: ${workDir}`];

  // Remote origin & project name
  if (remoteUrl) {
    const safeUrl = sanitizeRemoteUrl(remoteUrl);
    if (safeUrl) {
      sections.push(`Remote: ${safeUrl}`);
    }
    const project = parseProjectName(remoteUrl);
    if (project) {
      sections.push(`Project: ${project}`);
    }
  }

  // Current branch
  if (branch) {
    sections.push(`Branch: ${branch}`);
  }

  // Dirty files
  if (dirtyRaw !== null) {
    const dirtyLines = dirtyRaw.split('\n').filter((line) => line.trim());
    if (dirtyLines.length > 0) {
      const total = dirtyLines.length;
      const shown = dirtyLines.slice(0, MAX_DIRTY_FILES);
      const header = `Dirty files (${total}):`;
      let body = shown.map((line) => `  ${line}`).join('\n');
      if (total > MAX_DIRTY_FILES) {
        body += `\n  ... and ${total - MAX_DIRTY_FILES} more`;
      }
      sections.push(`${header}\n${body}`);
    }
  }

  // Recent commits
  if (logRaw) {
    const logLines = logRaw.split('\n').filter((line) => line.trim());
    if (logLines.length > 0) {
      const body = logLines.map((line) => `  ${line.slice(0, 200)}`).join('\n');
      sections.push(`Recent commits:\n${body}`);
    }
  }

  if (sections.length <= 1) {
    // Only the working directory line — nothing useful collected
    return '';
  }

  const content = sections.join('\n');
  return `<git-context>\n${content}\n</git-context>`;
}

// ── Utility ──────────────────────────────────────────────────────────

function escapeRegExp(str: string): string {
  return str.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
