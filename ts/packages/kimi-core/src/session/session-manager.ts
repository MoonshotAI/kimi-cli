/**
 * SessionManager — multi-session index (§6.4).
 *
 * Owns a `Map<session_id, SessionEntry>` and provides create / get / destroy /
 * list operations. Phase 1 uses lightweight session entries (not full SoulPlus)
 * since the test suite only validates Map-based CRUD.
 */

import { randomUUID } from 'node:crypto';

import type { PathConfig } from './path-config.js';

// ── SessionInfo (visible to session.list callers) ───────────────────────

export interface SessionInfo {
  session_id: string;
  created_at: number;
  model?: string | undefined;
  state?: string | undefined;
}

// ── CreateSessionParams ─────────────────────────────────────────────────

export interface CreateSessionParams {
  session_id?: string | undefined;
  model?: string | undefined;
  system_prompt?: string | undefined;
}

// ── Internal session entry ──────────────────────────────────────────────

interface SessionEntry {
  sessionId: string;
  createdAt: number;
  model?: string | undefined;
}

// ── SessionManager ──────────────────────────────────────────────────────

export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(private readonly _paths: PathConfig) {}

  create(params?: CreateSessionParams): SessionEntry {
    const sessionId = params?.session_id ?? `ses_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session already exists: ${sessionId}`);
    }
    const entry: SessionEntry = {
      sessionId,
      createdAt: Date.now(),
      model: params?.model,
    };
    this.sessions.set(sessionId, entry);
    return entry;
  }

  get(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  async destroy(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    this.sessions.delete(sessionId);
  }

  list(): SessionInfo[] {
    const result: SessionInfo[] = [];
    for (const [id, entry] of this.sessions) {
      result.push({
        session_id: id,
        created_at: entry.createdAt,
        model: entry.model,
      });
    }
    return result;
  }
}
