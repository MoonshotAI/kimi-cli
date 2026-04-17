/**
 * PathConfig — zero-hardcoded-path service (§9.5–§9.10).
 *
 * All filesystem paths derive from a single `KIMI_HOME` root:
 *   Priority: constructor `home` arg > `KIMI_HOME` env var > `~/.kimi`
 *
 * This is a pure data class with no async I/O — directory creation is the
 * caller's responsibility (SessionManager or main.ts).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export class PathConfig {
  readonly home: string;

  constructor(args?: { home?: string | undefined }) {
    this.home = args?.home ?? process.env['KIMI_HOME'] ?? join(homedir(), '.kimi');
  }

  get sessionsDir(): string {
    return join(this.home, 'sessions');
  }

  get sqlitePath(): string {
    return join(this.home, 'team_comms.db');
  }

  get configPath(): string {
    return join(this.home, 'config.json');
  }

  get tmpDir(): string {
    return join(this.home, 'tmp');
  }

  sessionDir(sessionId: string): string {
    return join(this.sessionsDir, sessionId);
  }

  wirePath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'wire.jsonl');
  }

  statePath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'state.json');
  }

  subagentDir(sessionId: string, subId: string): string {
    return join(this.sessionDir(sessionId), 'subagents', subId);
  }

  archivePath(sessionId: string, n: number): string {
    return join(this.sessionDir(sessionId), `wire.${n}.jsonl`);
  }

  /**
   * Slice 5 / 决策 #96 L1 — destination for over-budget tool results that
   * the orchestrator persists to disk. Layout follows v2 §10.6.3:
   * `<sessionDir>/tool-results/<toolCallId>.txt`.
   */
  toolResultArchivePath(sessionId: string, toolCallId: string): string {
    return join(this.sessionDir(sessionId), 'tool-results', `${toolCallId}.txt`);
  }

  // ── Slice 7.2 (决策 #100) — MCP path helpers ─────────────────────────

  /** Per-user MCP server config: `$KIMI_HOME/mcp.json`. */
  mcpConfigPath(): string {
    return join(this.home, 'mcp.json');
  }

  /** Per-project MCP server config: `<workDir>/.kimi/mcp.json`. */
  mcpProjectConfigPath(workDir: string): string {
    return join(workDir, '.kimi', 'mcp.json');
  }

  /** Directory holding per-server OAuth credentials. */
  mcpAuthDir(): string {
    return join(this.home, 'mcp-auth');
  }

  /** Per-server OAuth credential file. */
  mcpAuthPath(serverId: string): string {
    return join(this.mcpAuthDir(), `${serverId}.json`);
  }

  /**
   * Enterprise/managed MCP config. Platform-specific: `/etc/kimi/mcp.json`
   * on POSIX systems, `%ProgramData%/Kimi/mcp.json` on Windows.
   */
  enterpriseMcpConfigPath(): string {
    // Phase 17 §C.4 — `KIMI_ENTERPRISE_MCP_CONFIG` env override wins
    // over the platform default so enterprise deployments can swap the
    // config path without rebuilding.
    const override = process.env['KIMI_ENTERPRISE_MCP_CONFIG'];
    if (override !== undefined && override.length > 0) {
      return override;
    }
    if (process.platform === 'win32') {
      const programData = process.env['ProgramData'] ?? 'C:\\ProgramData';
      return join(programData, 'Kimi', 'mcp.json');
    }
    return '/etc/kimi/mcp.json';
  }
}
