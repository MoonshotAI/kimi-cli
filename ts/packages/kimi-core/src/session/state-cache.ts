/**
 * StateCache — state.json derived cache (§9续).
 *
 * Reads / writes `state.json` in a session directory. Used by
 * SessionManager to persist quick-access session metadata (model,
 * status, last turn timestamp) without replaying the full wire.jsonl.
 *
 * Slice 5.1 (Codex M2): writes go through `tmp + rename` (POSIX atomic)
 * so a crash mid-write never leaves a half-truncated state.json that
 * subsequent reads would treat as "missing". Read-modify-write callers
 * still need their own concurrency guard for "merge then write" races
 * across processes — see SessionManager.renameSession.
 */

import { randomBytes } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

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
    // Atomic write: write to tmp file then rename. Avoids leaving a
    // half-truncated state.json if the process crashes mid-write.
    const tmp = `${this.statePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    try {
      await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
      await rename(tmp, this.statePath);
    } catch (err) {
      try {
        await unlink(tmp);
      } catch {
        // best effort cleanup
      }
      throw err;
    }
  }
}
