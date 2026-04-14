/**
 * MockSessionStore -- in-memory session storage for development.
 *
 * Implements the session management operations that `MockWireClient`
 * delegates to: create, list, continue, fork, delete, set title.
 */

import type { SessionInfo } from './client.js';

// ── Internal Session Record ───────────────────────────────────────────

interface SessionRecord {
  id: string;
  workDir: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  /** Ordered list of turn IDs, used for fork-at-turn. */
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

  /**
   * Continue the most recent session for a work directory.
   * Returns the session ID or null if none exists.
   */
  continue(workDir: string): string | null {
    const candidates = [...this.sessions.values()]
      .filter((s) => s.workDir === workDir && !s.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return candidates[0]?.id ?? null;
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

    // Copy turns up to the specified point
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
      workDir: record.workDir,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      archived: record.archived,
    };
  }

  private toInfoList(records: SessionRecord[]): SessionInfo[] {
    return records.map((r) => this.toInfo(r)).sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
