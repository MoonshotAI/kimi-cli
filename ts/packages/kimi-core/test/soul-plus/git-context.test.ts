/**
 * git-context tests — parseProjectName, sanitizeRemoteUrl, collectGitContext.
 *
 * Slice 6.0 red-bar tests. All tests should FAIL until implementation lands.
 */

import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ALLOWED_HOSTS,
  collectGitContext,
  parseProjectName,
  sanitizeRemoteUrl,
} from '../../src/soul-plus/git-context.js';

// ── parseProjectName ─────────────────────────────────────────────────

describe('parseProjectName', () => {
  it('parses SSH format git@github.com:owner/repo.git', () => {
    expect(parseProjectName('git@github.com:owner/repo.git')).toBe('owner/repo');
  });

  it('parses SSH format without .git suffix', () => {
    expect(parseProjectName('git@github.com:owner/repo')).toBe('owner/repo');
  });

  it('parses HTTPS format https://github.com/owner/repo', () => {
    expect(parseProjectName('https://github.com/owner/repo')).toBe('owner/repo');
  });

  it('parses HTTPS format with .git suffix', () => {
    expect(parseProjectName('https://github.com/owner/repo.git')).toBe('owner/repo');
  });

  it('parses SSH format for non-github hosts', () => {
    expect(parseProjectName('git@gitlab.com:org/project.git')).toBe('org/project');
  });

  it('parses HTTPS format for non-github hosts', () => {
    expect(parseProjectName('https://gitee.com/org/project')).toBe('org/project');
  });

  it('returns null for invalid URL', () => {
    expect(parseProjectName('not-a-url')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseProjectName('')).toBeNull();
  });
});

// ── sanitizeRemoteUrl ────────────────────────────────────────────────

describe('sanitizeRemoteUrl', () => {
  it('returns SSH URL for github.com as-is', () => {
    const url = 'git@github.com:owner/repo.git';
    expect(sanitizeRemoteUrl(url)).toBe(url);
  });

  it('strips credentials from HTTPS URL for github.com', () => {
    const url = 'https://user:token@github.com/owner/repo.git';
    expect(sanitizeRemoteUrl(url)).toBe('https://github.com/owner/repo.git');
  });

  it('returns HTTPS URL without credentials as-is (normalized)', () => {
    const url = 'https://github.com/owner/repo.git';
    expect(sanitizeRemoteUrl(url)).toBe('https://github.com/owner/repo.git');
  });

  it('returns null for self-hosted host', () => {
    expect(sanitizeRemoteUrl('git@internal.corp.com:team/repo.git')).toBeNull();
  });

  it('returns null for spoofed host (github.com.evil)', () => {
    expect(sanitizeRemoteUrl('https://github.com.evil/owner/repo.git')).toBeNull();
  });

  it('returns null for spoofed SSH host (github.com.evil)', () => {
    expect(sanitizeRemoteUrl('git@github.com.evil:owner/repo.git')).toBeNull();
  });

  it('accepts all 6 allowed hosts via SSH', () => {
    for (const host of ALLOWED_HOSTS) {
      const url = `git@${host}:owner/repo.git`;
      const result = sanitizeRemoteUrl(url);
      expect(result, `Expected ${host} SSH to be accepted`).not.toBeNull();
    }
  });

  it('accepts all 6 allowed hosts via HTTPS', () => {
    for (const host of ALLOWED_HOSTS) {
      const url = `https://${host}/owner/repo.git`;
      const result = sanitizeRemoteUrl(url);
      expect(result, `Expected ${host} HTTPS to be accepted`).not.toBeNull();
    }
  });
});

// ── collectGitContext ────────────────────────────────────────────────

// Git identity env for CI environments without global git config
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
};

describe('collectGitContext', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kimi-git-ctx-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty string for non-git directory', async () => {
    const result = await collectGitContext(tmpDir);
    expect(result).toBe('');
  });

  it('returns <git-context> block in a real git repo', async () => {
    // Initialize a real git repo with a commit
    execSync('git init && git commit --allow-empty -m "init"', {
      cwd: tmpDir,
      stdio: 'pipe',
      env: gitEnv,
    });

    const result = await collectGitContext(tmpDir);
    expect(result).toContain('<git-context>');
    expect(result).toContain('</git-context>');
  });

  it('includes Working directory section', async () => {
    execSync('git init && git commit --allow-empty -m "init"', {
      cwd: tmpDir,
      stdio: 'pipe',
      env: gitEnv,
    });

    const result = await collectGitContext(tmpDir);
    expect(result).toContain('Working directory:');
  });

  it('includes Branch section', async () => {
    execSync('git init && git commit --allow-empty -m "init"', {
      cwd: tmpDir,
      stdio: 'pipe',
      env: gitEnv,
    });

    const result = await collectGitContext(tmpDir);
    expect(result).toContain('Branch:');
  });

  it('includes Recent commits section', async () => {
    execSync('git init && git commit --allow-empty -m "test commit"', {
      cwd: tmpDir,
      stdio: 'pipe',
      env: gitEnv,
    });

    const result = await collectGitContext(tmpDir);
    expect(result).toContain('Recent commits:');
    expect(result).toContain('test commit');
  });

  it('includes Remote and Project when origin is set', async () => {
    execSync(
      'git init && git commit --allow-empty -m "init" && git remote add origin git@github.com:test/repo.git',
      { cwd: tmpDir, stdio: 'pipe', env: gitEnv },
    );

    const result = await collectGitContext(tmpDir);
    expect(result).toContain('Remote:');
    expect(result).toContain('Project: test/repo');
  });

  it('includes Dirty files section for modified files', async () => {
    execSync('git init && git commit --allow-empty -m "init"', {
      cwd: tmpDir,
      stdio: 'pipe',
      env: gitEnv,
    });
    // Create an untracked file to make the repo dirty
    execSync('echo "dirty" > dirty.txt', { cwd: tmpDir, stdio: 'pipe' });

    const result = await collectGitContext(tmpDir);
    expect(result).toContain('Dirty files');
    expect(result).toContain('dirty.txt');
  });
});
