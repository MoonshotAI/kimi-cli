/**
 * ClientState -- lightweight client-side state for the current session.
 *
 * The session lifecycle (create, store, restore, fork) is managed by the
 * agent core via Wire protocol. The CLI only maintains a thin layer of
 * client-local state that does not need to persist server-side:
 *
 *  - `sessionId`: the current session ID (obtained from Wire).
 *  - `sessionApprovals`: tools approved for the duration of the session
 *    (via "approve for session" in the approval panel).
 *  - `editorCommand`: the external editor command (UI preference).
 */

// ── ClientState interface ───────────────────────────────────────────

export interface ClientState {
  /** Current session ID (from Wire). */
  sessionId: string;
  /** Tools approved for the whole session (approve_for_session). */
  sessionApprovals: Set<string>;
  /** External editor command override (client UI preference). */
  editorCommand: string | null;
}

// ── Factory ─────────────────────────────────────────────────────────

export function createClientState(sessionId: string): ClientState {
  return {
    sessionId,
    sessionApprovals: new Set(),
    editorCommand: null,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Record a tool as approved for the rest of the session. */
export function approveForSession(state: ClientState, toolName: string): void {
  state.sessionApprovals.add(toolName);
}

/** Check whether a tool has been session-approved. */
export function isSessionApproved(state: ClientState, toolName: string): boolean {
  return state.sessionApprovals.has(toolName);
}

/** Reset approvals (e.g. when switching sessions). */
export function clearSessionApprovals(state: ClientState): void {
  state.sessionApprovals.clear();
}
