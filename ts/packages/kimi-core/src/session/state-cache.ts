/**
 * StateCache — state.json derived cache (§9续).
 *
 * Reads / writes `state.json` in a session directory. Used by
 * SessionManager to persist quick-access session metadata (model,
 * status, last turn timestamp) without replaying the full wire.jsonl.
 *
 * Writes go through `atomicWrite` (write-tmp-fsync-rename, Decision #104)
 * so a crash mid-write never leaves a half-truncated state.json that
 * subsequent reads would treat as "missing". Read-modify-write callers
 * still need their own concurrency guard for "merge then write" races
 * across processes — see SessionManager.renameSession.
 */

import { readFile } from 'node:fs/promises';

import { atomicWrite } from '../storage/atomic-write.js';

export interface SessionState {
  session_id: string;
  model?: string | undefined;
  status?: string | undefined;
  last_turn_id?: string | undefined;
  last_turn_time?: number | undefined;
  created_at: number;
  updated_at: number;
  /**
   * Workspace directory at session creation time (Slice 4.3 Part 5).
   * Used by `--continue` to filter sessions by the current workdir so
   * resuming from a different project does not pick up an unrelated
   * session. Legacy sessions written before Slice 4.3 omit this field.
   */
  workspace_dir?: string | undefined;
  /**
   * Session-scoped auto-approve action labels learned via
   * "approve for session" (Slice 2.3). Stored alongside session metadata
   * so a restart keeps the decisions intact without depending on
   * wire.jsonl replay.
   */
  auto_approve_actions?: string[] | undefined;
  /**
   * User-set session title via the `/title` (rename) slash command
   * (Slice 5.1). When set, takes precedence over any synthesised title
   * (e.g. first user message) in `listSessions()`.
   */
  custom_title?: string | undefined;
  /**
   * Slice 5.2 — persisted plan mode flag. Written by `closeSession()`
   * as a fallback for scenarios where WAL replay is truncated.
   * `projectReplayState.planMode` (from `plan_mode_changed` WAL
   * records) takes precedence when available.
   */
  plan_mode?: boolean | undefined;
}

export class StateCache {
  constructor(private readonly statePath: string) {}

  async read(): Promise<SessionState | null> {
    try {
      const raw = await readFile(this.statePath, 'utf-8');
      if (raw.length === 0) {
        return null;
      }
      return JSON.parse(raw) as SessionState;
    } catch {
      return null;
    }
  }

  async write(state: SessionState): Promise<void> {
    await atomicWrite(this.statePath, JSON.stringify(state, null, 2));
  }
}
