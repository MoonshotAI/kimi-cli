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
}
