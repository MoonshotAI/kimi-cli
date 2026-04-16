import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getConfigPath,
  getDataDir,
  getLogDir,
  getMCPConfigPath,
  getSessionsDir,
} from '../../src/config/paths.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalEnv = { ...process.env };

beforeEach(() => {
  // Clear any KIMI_SHARE_DIR that may leak between tests.
  delete process.env['KIMI_SHARE_DIR'];
});

afterEach(() => {
  process.env = { ...originalEnv };
});

// ---------------------------------------------------------------------------
// getDataDir
// ---------------------------------------------------------------------------

describe('getDataDir', () => {
  it('returns ~/.kimi-next when KIMI_SHARE_DIR is not set', () => {
    delete process.env['KIMI_SHARE_DIR'];
    expect(getDataDir()).toBe(join(homedir(), '.kimi-next'));
  });

  it('returns KIMI_SHARE_DIR when set', () => {
    process.env['KIMI_SHARE_DIR'] = '/tmp/kimi-test-data';
    expect(getDataDir()).toBe('/tmp/kimi-test-data');
  });

  it('returns KIMI_SHARE_DIR even if it is a relative path', () => {
    process.env['KIMI_SHARE_DIR'] = 'relative/path';
    expect(getDataDir()).toBe('relative/path');
  });
});

// ---------------------------------------------------------------------------
// getSessionsDir
// ---------------------------------------------------------------------------

describe('getSessionsDir', () => {
  it('returns <dataDir>/sessions/<md5(workDir)>', () => {
    delete process.env['KIMI_SHARE_DIR'];
    const workDir = '/home/user/project';
    const hash = createHash('md5').update(workDir, 'utf-8').digest('hex');
    const expected = join(homedir(), '.kimi-next', 'sessions', hash);
    expect(getSessionsDir(workDir)).toBe(expected);
  });

  it('produces a 32-char hex hash segment', () => {
    const sessDir = getSessionsDir('/some/path');
    const parts = sessDir.split(sep);
    const hashPart = parts.at(-1)!;
    expect(hashPart).toMatch(/^[0-9a-f]{32}$/);
  });

  it('different workDirs produce different session dirs', () => {
    const a = getSessionsDir('/path/a');
    const b = getSessionsDir('/path/b');
    expect(a).not.toBe(b);
  });

  it('same workDir always produces the same session dir', () => {
    expect(getSessionsDir('/stable')).toBe(getSessionsDir('/stable'));
  });

  it('respects KIMI_SHARE_DIR override', () => {
    process.env['KIMI_SHARE_DIR'] = '/custom/data';
    const hash = createHash('md5').update('/proj', 'utf-8').digest('hex');
    expect(getSessionsDir('/proj')).toBe(join('/custom/data', 'sessions', hash));
  });
});

// ---------------------------------------------------------------------------
// getConfigPath
// ---------------------------------------------------------------------------

describe('getConfigPath', () => {
  it('returns <dataDir>/config.toml', () => {
    delete process.env['KIMI_SHARE_DIR'];
    expect(getConfigPath()).toBe(join(homedir(), '.kimi-next', 'config.toml'));
  });

  it('respects KIMI_SHARE_DIR', () => {
    process.env['KIMI_SHARE_DIR'] = '/x';
    expect(getConfigPath()).toBe(join('/x', 'config.toml'));
  });
});

// ---------------------------------------------------------------------------
// getMCPConfigPath
// ---------------------------------------------------------------------------

describe('getMCPConfigPath', () => {
  it('returns <dataDir>/mcp.json', () => {
    delete process.env['KIMI_SHARE_DIR'];
    expect(getMCPConfigPath()).toBe(join(homedir(), '.kimi-next', 'mcp.json'));
  });

  it('respects KIMI_SHARE_DIR', () => {
    process.env['KIMI_SHARE_DIR'] = '/y';
    expect(getMCPConfigPath()).toBe(join('/y', 'mcp.json'));
  });
});

// ---------------------------------------------------------------------------
// getLogDir
// ---------------------------------------------------------------------------

describe('getLogDir', () => {
  it('returns <dataDir>/logs', () => {
    delete process.env['KIMI_SHARE_DIR'];
    expect(getLogDir()).toBe(join(homedir(), '.kimi-next', 'logs'));
  });

  it('respects KIMI_SHARE_DIR', () => {
    process.env['KIMI_SHARE_DIR'] = '/z';
    expect(getLogDir()).toBe(join('/z', 'logs'));
  });
});
