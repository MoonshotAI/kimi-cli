/**
 * FileTokenStorage tests — round-trip persistence + permission checks.
 *
 * Scope guards: tokens never leak to process.env or other files; permission
 * 0600 is enforced; corrupted files return undefined rather than throwing.
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileTokenStorage } from '../../src/auth/storage.js';
import type { TokenInfo } from '../../src/auth/types.js';

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `kimi-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sampleToken(overrides: Partial<TokenInfo> = {}): TokenInfo {
  return {
    accessToken: 'at-abc',
    refreshToken: 'rt-xyz',
    expiresAt: 1_700_000_000,
    scope: 'read write',
    tokenType: 'Bearer',
    expiresIn: 3600,
    ...overrides,
  };
}

describe('FileTokenStorage', () => {
  let dir: string;
  let storage: FileTokenStorage;

  beforeEach(() => {
    dir = makeTmpDir();
    storage = new FileTokenStorage(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined when no token exists', async () => {
    expect(await storage.load('kimi-code')).toBeUndefined();
  });

  it('round-trips a token via save/load', async () => {
    const token = sampleToken();
    await storage.save('kimi-code', token);
    const loaded = await storage.load('kimi-code');
    expect(loaded).toEqual(token);
  });

  it('persists tokens in snake_case JSON (Python-compatible)', async () => {
    const token = sampleToken();
    await storage.save('kimi-code', token);
    const raw = readFileSync(join(dir, 'kimi-code.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed['access_token']).toBe('at-abc');
    expect(parsed['refresh_token']).toBe('rt-xyz');
    expect(parsed['expires_at']).toBe(1_700_000_000);
    expect(parsed['token_type']).toBe('Bearer');
    expect(parsed['expires_in']).toBe(3600);
    expect(parsed['accessToken']).toBeUndefined();
  });

  it('writes the credentials file with mode 0600', async () => {
    await storage.save('kimi-code', sampleToken());
    const stat = statSync(join(dir, 'kimi-code.json'));
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('remove() deletes the file; load() then returns undefined', async () => {
    await storage.save('kimi-code', sampleToken());
    await storage.remove('kimi-code');
    expect(await storage.load('kimi-code')).toBeUndefined();
  });

  it('remove() is idempotent when file is absent', async () => {
    await expect(storage.remove('never-existed')).resolves.toBeUndefined();
  });

  it('save() overwrites an existing token atomically', async () => {
    await storage.save('kimi-code', sampleToken({ accessToken: 'first' }));
    await storage.save('kimi-code', sampleToken({ accessToken: 'second' }));
    const loaded = await storage.load('kimi-code');
    expect(loaded?.accessToken).toBe('second');
  });

  it('load() returns undefined on corrupt JSON (does not throw)', async () => {
    const file = join(dir, 'kimi-code.json');
    writeFileSync(file, '{ not json', 'utf-8');
    chmodSync(file, 0o600);
    expect(await storage.load('kimi-code')).toBeUndefined();
  });

  it('load() returns undefined on malformed payload (not a dict)', async () => {
    const file = join(dir, 'kimi-code.json');
    writeFileSync(file, '["array", "instead"]', 'utf-8');
    chmodSync(file, 0o600);
    expect(await storage.load('kimi-code')).toBeUndefined();
  });

  it('load() tolerates missing numeric fields by defaulting to 0', async () => {
    const file = join(dir, 'kimi-code.json');
    writeFileSync(file, JSON.stringify({ access_token: 'a', refresh_token: 'r' }), 'utf-8');
    chmodSync(file, 0o600);
    const token = await storage.load('kimi-code');
    expect(token?.expiresAt).toBe(0);
    expect(token?.expiresIn).toBe(0);
  });

  it('list() returns all stored token names', async () => {
    await storage.save('kimi-code', sampleToken());
    await storage.save('other-provider', sampleToken());
    const names = await storage.list();
    expect(names.sort()).toEqual(['kimi-code', 'other-provider']);
  });

  it('list() ignores non-JSON files in the credentials dir', async () => {
    await storage.save('kimi-code', sampleToken());
    writeFileSync(join(dir, 'kimi-code.lock'), 'lock', 'utf-8');
    writeFileSync(join(dir, 'readme.txt'), 'readme', 'utf-8');
    const names = await storage.list();
    expect(names).toEqual(['kimi-code']);
  });

  it('creates the credentials dir with mode 0700 if missing', async () => {
    const freshDir = join(dir, 'nested', 'sub');
    const s = new FileTokenStorage(freshDir);
    await s.save('kimi-code', sampleToken());
    const stat = statSync(freshDir);
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('refuses path-traversal names on save (B1)', async () => {
    await expect(storage.save('../../etc/passwd', sampleToken())).rejects.toThrow(/Invalid token name/);
  });

  it('refuses path-traversal names on load', async () => {
    await expect(storage.load('../etc/passwd')).rejects.toThrow(/Invalid token name/);
  });

  it('refuses path-traversal names on remove', async () => {
    await expect(storage.remove('../etc/passwd')).rejects.toThrow(/Invalid token name/);
  });

  it('refuses leading-dot names (hidden file abuse)', async () => {
    await expect(storage.save('.hidden', sampleToken())).rejects.toThrow(/Invalid token name/);
  });

  it('refuses empty name', async () => {
    await expect(storage.save('', sampleToken())).rejects.toThrow(/Invalid token name/);
  });
});
