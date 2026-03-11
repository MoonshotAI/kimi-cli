import { create } from "zustand";

export type SessionStatusSnapshot = {
  state: string;
  reason?: string;
  seq?: number;
  updatedAt?: Date;
};

type SessionAttentionState = {
  /** Session IDs that need user attention (completed unread, etc.) */
  attention: Record<string, boolean>;
  /** Last known session state from server (for sidebar dot rendering) */
  sessionStates: Record<string, string>;
  /** Last known runtime snapshot from server for transition detection */
  sessionSnapshots: Record<string, SessionStatusSnapshot>;

  /** Mark a session as needing attention */
  setAttention: (sessionId: string) => void;
  /** Clear attention for a session (user viewed it) */
  clearAttention: (sessionId: string) => void;
  /** Update the cached runtime snapshot for a session */
  setSessionSnapshot: (
    sessionId: string,
    snapshot: SessionStatusSnapshot,
  ) => void;
};

export const useSessionAttentionStore = create<SessionAttentionState>(
  (set) => ({
    attention: {},
    sessionStates: {},
    sessionSnapshots: {},

    setAttention: (sessionId) =>
      set((s) => ({
        attention: { ...s.attention, [sessionId]: true },
      })),

    clearAttention: (sessionId) =>
      set((s) => {
        if (!s.attention[sessionId]) return s;
        const next = { ...s.attention };
        delete next[sessionId];
        return { attention: next };
      }),

    setSessionSnapshot: (sessionId, snapshot) =>
      set((s) => ({
        sessionStates: { ...s.sessionStates, [sessionId]: snapshot.state },
        sessionSnapshots: {
          ...s.sessionSnapshots,
          [sessionId]: snapshot,
        },
      })),
  }),
);
