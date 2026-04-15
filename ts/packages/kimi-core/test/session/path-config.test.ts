/**
 * PathConfig — zero-hardcoded-path derivation tests (§9.5–§9.10).
 *
 * New v2-only tests — Python had no isolated PathConfig tests (path logic
 * was embedded in the Session class). These test all derived path getters
 * and the priority resolution (arg > env > default).
 *
 * PathConfig is already implemented (not a stub), so these tests should
 * PASS after implementation. They serve as regression guards.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PathConfig } from '../../src/session/index.js';

// ── Default resolution ──────────────────────────────────────────────────

describe('PathConfig default resolution', () => {
  it('defaults to ~/.kimi when no arg and no env', () => {
    const saved = process.env['KIMI_HOME'];
    delete process.env['KIMI_HOME'];
    try {
      const config = new PathConfig();
      expect(config.home).toBe(join(homedir(), '.kimi'));
    } finally {
      if (saved !== undefined) process.env['KIMI_HOME'] = saved;
    }
  });

  it('uses KIMI_HOME env var when set', () => {
    const saved = process.env['KIMI_HOME'];
    process.env['KIMI_HOME'] = '/tmp/test-kimi';
    try {
      const config = new PathConfig();
      expect(config.home).toBe('/tmp/test-kimi');
    } finally {
      if (saved !== undefined) process.env['KIMI_HOME'] = saved;
      else delete process.env['KIMI_HOME'];
    }
  });

  it('constructor arg takes priority over env var', () => {
    const saved = process.env['KIMI_HOME'];
    process.env['KIMI_HOME'] = '/tmp/env-kimi';
    try {
      const config = new PathConfig({ home: '/tmp/arg-kimi' });
      expect(config.home).toBe('/tmp/arg-kimi');
    } finally {
      if (saved !== undefined) process.env['KIMI_HOME'] = saved;
      else delete process.env['KIMI_HOME'];
    }
  });
});

// ── Derived paths ────────────────────────────────────────────────────────

describe('PathConfig derived paths', () => {
  const config = new PathConfig({ home: '/test/kimi' });

  it('sessionsDir', () => {
    expect(config.sessionsDir).toBe('/test/kimi/sessions');
  });

  it('sqlitePath', () => {
    expect(config.sqlitePath).toBe('/test/kimi/team_comms.db');
  });

  it('configPath', () => {
    expect(config.configPath).toBe('/test/kimi/config.json');
  });

  it('tmpDir', () => {
    expect(config.tmpDir).toBe('/test/kimi/tmp');
  });

  it('sessionDir(id)', () => {
    expect(config.sessionDir('ses_abc')).toBe('/test/kimi/sessions/ses_abc');
  });

  it('wirePath(id)', () => {
    expect(config.wirePath('ses_abc')).toBe('/test/kimi/sessions/ses_abc/wire.jsonl');
  });

  it('statePath(id)', () => {
    expect(config.statePath('ses_abc')).toBe('/test/kimi/sessions/ses_abc/state.json');
  });

  it('subagentDir(sessionId, subId)', () => {
    expect(config.subagentDir('ses_abc', 'sub_1')).toBe(
      '/test/kimi/sessions/ses_abc/subagents/sub_1',
    );
  });

  it('archivePath(sessionId, n)', () => {
    expect(config.archivePath('ses_abc', 1)).toBe('/test/kimi/sessions/ses_abc/wire.1.jsonl');
    expect(config.archivePath('ses_abc', 3)).toBe('/test/kimi/sessions/ses_abc/wire.3.jsonl');
  });
});

// ── Isolation guarantee (§9.10) ─────────────────────────────────────────

describe('PathConfig isolation', () => {
  it('different home values produce entirely disjoint paths', () => {
    const a = new PathConfig({ home: '/instance/a' });
    const b = new PathConfig({ home: '/instance/b' });

    expect(a.sessionsDir).not.toBe(b.sessionsDir);
    expect(a.sqlitePath).not.toBe(b.sqlitePath);
    expect(a.configPath).not.toBe(b.configPath);
    expect(a.tmpDir).not.toBe(b.tmpDir);
    expect(a.wirePath('ses_1')).not.toBe(b.wirePath('ses_1'));
  });

  it('no path contains hardcoded ~/.kimi when home is overridden', () => {
    const config = new PathConfig({ home: '/custom/path' });
    const allPaths = [
      config.home,
      config.sessionsDir,
      config.sqlitePath,
      config.configPath,
      config.tmpDir,
      config.sessionDir('ses_1'),
      config.wirePath('ses_1'),
      config.statePath('ses_1'),
      config.subagentDir('ses_1', 'sub_1'),
      config.archivePath('ses_1', 1),
    ];
    for (const p of allPaths) {
      expect(p).not.toContain('.kimi');
      expect(p.startsWith('/custom/path')).toBe(true);
    }
  });
});
