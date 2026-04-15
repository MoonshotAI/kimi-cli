/**
 * Session management hook.
 *
 * Handles session lifecycle based on CLI parameters:
 *  - `--session <id>`: resume a specific session via Wire.
 *  - `--continue`:      resume the most recent session for workDir via Wire.
 *  - Neither:           a new session has already been created by index.ts.
 *
 * Also provides helpers for switching sessions (used by SessionPicker)
 * and listing sessions.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { WireClient } from '../../wire/index.js';
import type { SessionInfo } from '../../wire/methods.js';
import type { AppState } from '../context.js';

export interface UseSessionOptions {
  wireClient: WireClient;
  sessionId: string;
  setState: (patch: Partial<AppState>) => void;
}

export interface UseSessionResult {
  /** List of sessions fetched from Wire. */
  sessions: SessionInfo[];
  /** Whether the session list is currently loading. */
  loadingSessions: boolean;
  /** Refresh the session list from Wire. */
  refreshSessions: () => Promise<void>;
  /** Switch to a different session by ID. */
  switchSession: (newSessionId: string) => void;
}

export function useSession({
  wireClient,
  sessionId,
  setState,
}: UseSessionOptions): UseSessionResult {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const fetchedRef = useRef(false);

  const refreshSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const result = await wireClient.listSessions();
      setSessions(result.sessions);
    } catch {
      // Silently ignore -- mock may not have sessions
    } finally {
      setLoadingSessions(false);
    }
  }, [wireClient]);

  // Fetch sessions once on mount.
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    void refreshSessions();
  }, [refreshSessions]);

  const switchSession = useCallback(
    (newSessionId: string) => {
      setState({ sessionId: newSessionId });
      // Resume the session via Wire so core can replay history.
      void wireClient.resume(newSessionId);
    },
    [wireClient, setState],
  );

  return {
    sessions,
    loadingSessions,
    refreshSessions,
    switchSession,
  };
}
