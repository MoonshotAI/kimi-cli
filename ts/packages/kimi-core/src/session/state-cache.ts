/**
 * StateCache — state.json derived cache (§9续).
 *
 * Reads / writes `state.json` in a session directory. Used by
 * SessionManager to persist quick-access session metadata (model,
 * status, last turn timestamp) without replaying the full wire.jsonl.
 */

import { readFile, writeFile } from 'node:fs/promises';

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
    await writeFile(this.statePath, JSON.stringify(state, null, 2), 'utf-8');
  }
}
