/**
 * Covers: rg-locator (Bug #1 fix — ripgrep hybrid binary resolution).
 *
 * Pure-lookup pins (no real CDN download):
 *   - `findExistingRg` returns undefined when PATH + share-bin are both empty
 *   - Resolves from `<shareDir>/bin/rg` when that binary exists
 *   - Prefers system PATH over share-dir cache when both are available
 *   - `rgUnavailableMessage` surfaces the underlying cause + install hints
 */

import { mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  detectTarget,
  findExistingRg,
  rgUnavailableMessage,
} from '../../src/tools/rg-locator.js';

describe('findExistingRg', () => {
  let fakeShare: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    fakeShare = join(
      tmpdir(),
      `kimi-rg-${String(Date.now())}-${String(Math.random()).slice(2)}`,
    );
    mkdirSync(join(fakeShare, 'bin'), { recursive: true });
    savedPath = process.env['PATH'];
    // Empty PATH → rules out step 1 (system-path) for the default case.
    process.env['PATH'] = '';
  });
  afterEach(() => {
    rmSync(fakeShare, { recursive: true, force: true });
    if (savedPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = savedPath;
  });

  it('returns undefined when no rg anywhere', async () => {
    const result = await findExistingRg(fakeShare);
    expect(result).toBeUndefined();
  });

  it('resolves from share-dir when cached', async () => {
    const cached = join(
      fakeShare,
      'bin',
      process.platform === 'win32' ? 'rg.exe' : 'rg',
    );
    writeFileSync(cached, '#!/bin/sh\necho ripgrep 15.0.0\n');
    chmodSync(cached, 0o755);
    const result = await findExistingRg(fakeShare);
    expect(result).toEqual({ path: cached, source: 'share-bin-cached' });
  });

  it('prefers system PATH over share-dir when both are available', async () => {
    // Stage a fake rg on PATH.
    const pathDir = join(fakeShare, 'path');
    mkdirSync(pathDir, { recursive: true });
    const onPath = join(
      pathDir,
      process.platform === 'win32' ? 'rg.exe' : 'rg',
    );
    writeFileSync(onPath, '#!/bin/sh\n');
    chmodSync(onPath, 0o755);
    process.env['PATH'] = pathDir;
    // Also stage a cached one to confirm the order.
    const cached = join(
      fakeShare,
      'bin',
      process.platform === 'win32' ? 'rg.exe' : 'rg',
    );
    writeFileSync(cached, '#!/bin/sh\n');
    chmodSync(cached, 0o755);
    const result = await findExistingRg(fakeShare);
    expect(result?.source).toBe('system-path');
    expect(result?.path).toBe(onPath);
  });
});

describe('detectTarget', () => {
  let savedArch: string;
  let savedPlatform: string;
  beforeEach(() => {
    savedArch = process.arch;
    savedPlatform = process.platform;
  });
  afterEach(() => {
    Object.defineProperty(process, 'arch', { value: savedArch });
    Object.defineProperty(process, 'platform', { value: savedPlatform });
  });

  function setPlatform(arch: string, platform: string): void {
    Object.defineProperty(process, 'arch', { value: arch });
    Object.defineProperty(process, 'platform', { value: platform });
  }

  it('darwin arm64 → aarch64-apple-darwin', () => {
    setPlatform('arm64', 'darwin');
    expect(detectTarget()).toBe('aarch64-apple-darwin');
  });
  it('darwin x64 → x86_64-apple-darwin', () => {
    setPlatform('x64', 'darwin');
    expect(detectTarget()).toBe('x86_64-apple-darwin');
  });
  it('linux x64 → x86_64-unknown-linux-musl', () => {
    setPlatform('x64', 'linux');
    expect(detectTarget()).toBe('x86_64-unknown-linux-musl');
  });
  it('linux arm64 → aarch64-unknown-linux-gnu', () => {
    setPlatform('arm64', 'linux');
    expect(detectTarget()).toBe('aarch64-unknown-linux-gnu');
  });
  it('win32 x64 → x86_64-pc-windows-msvc', () => {
    setPlatform('x64', 'win32');
    expect(detectTarget()).toBe('x86_64-pc-windows-msvc');
  });
  it('unsupported arch → undefined', () => {
    setPlatform('mips', 'linux');
    expect(detectTarget()).toBeUndefined();
  });
});

describe('rgUnavailableMessage', () => {
  it('surfaces the underlying cause and install hints', () => {
    const msg = rgUnavailableMessage(new Error('fetch failed'));
    expect(msg).toContain('fetch failed');
    expect(msg).toContain('brew install ripgrep');
    expect(msg).toContain('https://github.com/BurntSushi/ripgrep');
  });

  it('handles non-Error causes (string, unknown)', () => {
    const a = rgUnavailableMessage('boom');
    expect(a).toContain('boom');
    const b = rgUnavailableMessage(42);
    expect(b).toContain('unknown error');
  });
});
