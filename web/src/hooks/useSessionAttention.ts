import { create } from "zustand";

type SessionAttentionState = {
  /** Session IDs that need user attention (completed unread, approval request, etc.) */
  attention: Record<string, boolean>;
  /** Last known session state from server (for busy dot rendering) */
  sessionStates: Record<string, string>;

  /** Mark a session as needing attention */
  setAttention: (sessionId: string) => void;
  /** Clear attention for a session (user viewed it) */
  clearAttention: (sessionId: string) => void;
  /** Update the cached state for a session */
  setSessionState: (sessionId: string, state: string) => void;
};

export const useSessionAttentionStore = create<SessionAttentionState>(
  (set) => ({
    attention: {},
    sessionStates: {},

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

    setSessionState: (sessionId, state) =>
      set((s) => ({
        sessionStates: { ...s.sessionStates, [sessionId]: state },
      })),
  }),
);
