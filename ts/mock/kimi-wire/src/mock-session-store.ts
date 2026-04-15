/**
 * MockSessionStore -- in-memory session storage for development.
 *
 * Implements session management operations delegated to by
 * MockDataSource / WireClientImpl.
 */

import type { SessionInfo } from './types.js';

// ── Internal Session Record ───────────────────────────────────────────

interface SessionRecord {
  id: string;
  workDir: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  turns: number[];
}

// ── MockSessionStore ──────────────────────────────────────────────────

export class MockSessionStore {
  private sessions = new Map<string, SessionRecord>();
  private counter = 0;

  /** Create a new session for the given work directory. Returns the session ID. */
  create(workDir: string): string {
    const id = `session-${(++this.counter).toString().padStart(4, '0')}`;
    const now = Date.now();
    this.sessions.set(id, {
      id,
      workDir,
      title: null,
      createdAt: now,
      updatedAt: now,
      archived: false,
      turns: [],
    });
    return id;
  }

  /** List sessions for a specific work directory. */
  list(workDir: string): SessionInfo[] {
    return this.toInfoList(
      [...this.sessions.values()].filter((s) => s.workDir === workDir && !s.archived),
    );
  }

  /** List all sessions across all work directories. */
  listAll(): SessionInfo[] {
    return this.toInfoList([...this.sessions.values()].filter((s) => !s.archived));
  }

  /** Delete a session by ID. Throws if not found. */
  delete(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    this.sessions.delete(sessionId);
  }

  /**
   * Fork a session, optionally at a specific turn number.
   * Returns the new session ID.
   */
  fork(sessionId: string, atTurn?: number): string {
    const source = this.sessions.get(sessionId);
    if (source === undefined) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const newId = this.create(source.workDir);
    const newSession = this.sessions.get(newId)!;
    newSession.title = source.title !== null ? `${source.title} (fork)` : null;

    if (atTurn !== undefined) {
      newSession.turns = source.turns.filter((t) => t <= atTurn);
    } else {
      newSession.turns = [...source.turns];
    }

    return newId;
  }

  /** Set a custom title for a session. */
  setTitle(sessionId: string, title: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    session.title = title;
    session.updatedAt = Date.now();
  }

  /** Record that a turn happened in this session. */
  recordTurn(sessionId: string, turnNumber: number): void {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) {
      session.turns.push(turnNumber);
      session.updatedAt = Date.now();
    }
  }

  /** Get a session record by ID (for testing). */
  get(sessionId: string): SessionInfo | undefined {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return undefined;
    return this.toInfo(record);
  }

  // ── Internal ──────────────────────────────────────────────────────

  private toInfo(record: SessionRecord): SessionInfo {
    return {
      id: record.id,
      work_dir: record.workDir,
      title: record.title,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      archived: record.archived,
    };
  }

  private toInfoList(records: SessionRecord[]): SessionInfo[] {
    return records.map((r) => this.toInfo(r)).sort((a, b) => b.updated_at - a.updated_at);
  }
}
