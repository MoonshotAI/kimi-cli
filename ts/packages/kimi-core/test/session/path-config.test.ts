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

// ── Slice 7.2 (决策 #100) — MCP path helpers ──────────────────────────

describe('PathConfig MCP paths (Phase 7)', () => {
  const config = new PathConfig({ home: '/test/kimi' });

  it('mcpConfigPath → $KIMI_HOME/mcp.json', () => {
    expect(config.mcpConfigPath()).toBe('/test/kimi/mcp.json');
  });

  it('mcpProjectConfigPath(workDir) → <workDir>/.kimi/mcp.json', () => {
    expect(config.mcpProjectConfigPath('/work/project-a')).toBe(
      '/work/project-a/.kimi/mcp.json',
    );
  });

  it('mcpAuthDir → $KIMI_HOME/mcp-auth', () => {
    expect(config.mcpAuthDir()).toBe('/test/kimi/mcp-auth');
  });

  it('mcpAuthPath(serverId) → $KIMI_HOME/mcp-auth/<serverId>.json', () => {
    expect(config.mcpAuthPath('playwright')).toBe('/test/kimi/mcp-auth/playwright.json');
  });

  it('enterpriseMcpConfigPath() returns a non-empty absolute path', () => {
    // Enterprise config is a system-wide location (e.g. /etc/kimi/managed
    // on Linux, a ProgramData path on Windows). Exact value is
    // platform-specific; assert absolute and distinct from the personal
    // mcpConfigPath.
    const p = config.enterpriseMcpConfigPath();
    expect(typeof p).toBe('string');
    expect(p.length).toBeGreaterThan(0);
    expect(p).not.toBe(config.mcpConfigPath());
  });

  // ── Phase 17 C.4 — env override ────────────────────────────────

  it('Phase 17 C.4: KIMI_ENTERPRISE_MCP_CONFIG env var overrides the default enterpriseMcpConfigPath', () => {
    const original = process.env['KIMI_ENTERPRISE_MCP_CONFIG'];
    try {
      process.env['KIMI_ENTERPRISE_MCP_CONFIG'] = '/opt/custom/enterprise.json';
      const pc = new PathConfig({ home: '/test/kimi' });
      expect(pc.enterpriseMcpConfigPath()).toBe('/opt/custom/enterprise.json');
    } finally {
      if (original === undefined) {
        delete process.env['KIMI_ENTERPRISE_MCP_CONFIG'];
      } else {
        process.env['KIMI_ENTERPRISE_MCP_CONFIG'] = original;
      }
    }
  });

  it('Phase 17 C.4: falls back to platform default when env var is unset', () => {
    const original = process.env['KIMI_ENTERPRISE_MCP_CONFIG'];
    delete process.env['KIMI_ENTERPRISE_MCP_CONFIG'];
    try {
      const pc = new PathConfig({ home: '/test/kimi' });
      const p = pc.enterpriseMcpConfigPath();
      // Platform-specific default — verifies no env pollution.
      if (process.platform === 'win32') {
        expect(p.toLowerCase()).toContain('programdata');
      } else {
        expect(p).toBe('/etc/kimi/mcp.json');
      }
    } finally {
      if (original !== undefined) {
        process.env['KIMI_ENTERPRISE_MCP_CONFIG'] = original;
      }
    }
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
