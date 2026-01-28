import { useState, useCallback, useRef, useEffect } from "react";
import type {
  Session,
  UploadSessionFileResponse,
  SessionStatus,
} from "../lib/api/models";
import { apiClient } from "../lib/apiClient";
import { formatRelativeTime, getApiBaseUrl } from "./utils";

// Regex patterns for path normalization
const LEADING_DOT_SLASH_REGEX = /^\.\/+/;
const LEADING_SLASH_REGEX = /^\/+/;
const TRAILING_WHITESPACE_REGEX = /\s+$/;

export type SessionFileEntry = {
  name: string;
  type: "directory" | "file";
  size?: number;
};

type UseSessionsReturn = {
  /** List of sessions (API Session type) */
  sessions: Session[];
  /** Currently selected session ID */
  selectedSessionId: string;
  /** Loading state */
  isLoading: boolean;
  /** Error message if any */
  error: string | null;
  /** Refresh sessions list from API */
  refreshSessions: () => Promise<void>;
  /** Refresh a single session's data from API */
  refreshSession: (sessionId: string) => Promise<Session | null>;
  /** Create a new session */
  createSession: (workDir?: string) => Promise<Session>;
  /** Delete a session by ID */
  deleteSession: (sessionId: string) => Promise<boolean>;
  /** Select a session */
  selectSession: (sessionId: string) => void;
  /** Apply a runtime session status update */
  applySessionStatus: (status: SessionStatus) => void;
  /** Get formatted relative time for a session */
  getRelativeTime: (session: Session) => string;
  /** Upload a file to a session's work_dir */
  uploadSessionFile: (
    sessionId: string,
    file: File,
  ) => Promise<UploadSessionFileResponse>;
  /** List files in a session's work_dir path */
  listSessionDirectory: (
    sessionId: string,
    path?: string,
  ) => Promise<SessionFileEntry[]>;
  /** Get a file from a session's work_dir */
  getSessionFile: (sessionId: string, path: string) => Promise<Blob>;
  /** Get the URL for a session file (for direct access/download) */
  getSessionFileUrl: (sessionId: string, path: string) => string;
  /** Fetch available work directories */
  fetchWorkDirs: () => Promise<string[]>;
  /** Fetch the startup directory */
  fetchStartupDir: () => Promise<string>;
};

const normalizeSessionPath = (value?: string): string => {
  if (!value) {
    return ".";
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "/" || trimmed === ".") {
    return ".";
  }
  const stripped = trimmed
    .replace(LEADING_DOT_SLASH_REGEX, "")
    .replace(LEADING_SLASH_REGEX, "")
    .replace(TRAILING_WHITESPACE_REGEX, "");
  return stripped === "" ? "." : stripped;
};

/**
 * Hook for managing sessions with real API calls
 */
export function useSessions(): UseSessionsReturn {
  // Sessions list (using API Session type)
  const [sessions, setSessions] = useState<Session[]>([]);

  // Currently selected session
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");

  // Loading and error states
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track initialization
  const isInitializedRef = useRef(false);

  /**
   * Refresh sessions list from API
   */
  const refreshSessions = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const sessionsList =
        await apiClient.sessions.listSessionsApiSessionsGet();

      // Update sessions list
      setSessions(sessionsList);

      // Don't auto-select first session - user can click on one or create a new one
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load sessions";
      setError(message);
      console.error("Failed to refresh sessions:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const applySessionStatus = useCallback((status: SessionStatus) => {
    setSessions((current) =>
      current.map((session) =>
        session.sessionId === status.sessionId
          ? { ...session, status }
          : session,
      ),
    );
  }, []);

  // Initial load
  useEffect(() => {
    if (!isInitializedRef.current) {
      isInitializedRef.current = true;
      refreshSessions();
    }
  }, [refreshSessions]);

  // Auto-refresh sessions list every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      refreshSessions();
    }, 30000);
    return () => clearInterval(interval);
  }, [refreshSessions]);

  /**
   * Refresh a single session's data from API
   * Returns: Session (API type) or null if not found
   * @param sessionId - The session ID to refresh
   */
  const refreshSession = useCallback(
    async (sessionId: string): Promise<Session | null> => {
      try {
        const session =
          await apiClient.sessions.getSessionApiSessionsSessionIdGet({
            sessionId,
          });

        // Update sessions list
        setSessions((current) =>
          current.map((s) => (s.sessionId === sessionId ? session : s)),
        );

        return session;
      } catch (err) {
        console.error("Failed to refresh session:", sessionId, err);
        return null;
      }
    },
    [],
  );

  /**
   * Create a new session
   * Returns: Session (API type)
   * @param workDir - Optional working directory for the session
   */
  const createSession = useCallback(
    async (workDir?: string): Promise<Session> => {
      setIsLoading(true);
      setError(null);
      try {
        // Use fetch directly to support the work_dir parameter
        const basePath = getApiBaseUrl();
        const response = await fetch(`${basePath}/api/sessions/`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: workDir ? JSON.stringify({ work_dir: workDir }) : undefined,
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.detail || "Failed to create session");
        }

        const sessionData = await response.json();
        // Convert snake_case to camelCase
        const session: Session = {
          sessionId: sessionData.session_id,
          title: sessionData.title,
          lastUpdated: new Date(sessionData.last_updated),
          isRunning: sessionData.is_running,
          status: sessionData.status,
          workDir: sessionData.work_dir,
          sessionDir: sessionData.session_dir,
        };

        // Update sessions list (add to beginning)
        setSessions((current) => [session, ...current]);

        // Select the new session
        setSelectedSessionId(session.sessionId);

        return session;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to create session";
        setError(message);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  /**
   * Delete a session
   */
  const deleteSession = useCallback(
    async (sessionId: string): Promise<boolean> => {
      setIsLoading(true);
      setError(null);

      try {
        await apiClient.sessions.deleteSessionApiSessionsSessionIdDelete({
          sessionId,
        });

        // Update sessions list
        setSessions((current) => {
          const next = current.filter((s) => s.sessionId !== sessionId);

          // If we deleted the selected session, select the first remaining one
          if (sessionId === selectedSessionId && next.length > 0) {
            setSelectedSessionId(next[0].sessionId);
          } else if (next.length === 0) {
            setSelectedSessionId("");
          }

          return next;
        });

        return true;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to delete session";
        setError(message);
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [selectedSessionId],
  );

  /**
   * Select a session
   */
  const selectSession = useCallback((sessionId: string) => {
    console.log("[useSessions] Selecting session:", sessionId);
    setSelectedSessionId(sessionId);
  }, []);

  /**
   * Get formatted relative time for a session
   */
  const getRelativeTime = useCallback(
    (session: Session): string => formatRelativeTime(session.lastUpdated),
    [],
  );

  /**
   * Upload a file to a session's work_dir
   * Returns: UploadSessionFileResponse with path, filename, and size
   */
  const uploadSessionFile = useCallback(
    async (
      sessionId: string,
      file: File,
    ): Promise<UploadSessionFileResponse> => {
      try {
        const response =
          await apiClient.sessions.uploadSessionFileApiSessionsSessionIdFilesPost(
            {
              sessionId,
              file,
            },
          );
        return response;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to upload file";
        setError(message);
        throw err;
      }
    },
    [],
  );

  /**
   * List files/directories under a path within the session work_dir
   */
  const listSessionDirectory = useCallback(
    async (sessionId: string, path?: string): Promise<SessionFileEntry[]> => {
      // Note: We don't set global error here since file listing failures
      // are handled locally by the session-files-panel component
      const response =
        await apiClient.sessions.getSessionFileApiSessionsSessionIdFilesPathGetRaw(
          {
            sessionId,
            path: normalizeSessionPath(path),
          },
        );
      const contentType =
        response.raw.headers.get("content-type") ?? "application/octet-stream";
      if (!contentType.includes("application/json")) {
        throw new Error("Requested path is not a directory");
      }
      const entries = (await response.value()) as SessionFileEntry[];
      return entries;
    },
    [],
  );

  /**
   * Get a file from a session's work_dir
   * Returns: Blob of the file content
   */
  const getSessionFile = useCallback(
    async (sessionId: string, path: string): Promise<Blob> => {
      setError(null);
      try {
        const response =
          await apiClient.sessions.getSessionFileApiSessionsSessionIdFilesPathGetRaw(
            {
              sessionId,
              path: normalizeSessionPath(path),
            },
          );
        const contentType =
          response.raw.headers.get("content-type") ??
          "application/octet-stream";
        if (contentType.includes("application/json")) {
          throw new Error("Requested path is a directory, not a file");
        }
        return await response.raw.blob();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to get file";
        setError(message);
        throw err;
      }
    },
    [],
  );

  /**
   * Get the URL for a session file (for direct access/download)
   */
  const getSessionFileUrl = useCallback(
    (sessionId: string, path: string): string => {
      const basePath = getApiBaseUrl();
      return `${basePath}/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(path)}`;
    },
    [],
  );

  /**
   * Fetch available work directories from the backend
   */
  const fetchWorkDirs = useCallback(async (): Promise<string[]> => {
    const basePath = getApiBaseUrl();
    const response = await fetch(`${basePath}/api/work-dirs/`);

    if (!response.ok) {
      throw new Error("Failed to fetch work directories");
    }

    return response.json();
  }, []);

  /**
   * Fetch the startup directory from the backend
   */
  const fetchStartupDir = useCallback(async (): Promise<string> => {
    const basePath = getApiBaseUrl();
    const response = await fetch(`${basePath}/api/work-dirs/startup`);

    if (!response.ok) {
      throw new Error("Failed to fetch startup directory");
    }

    return response.json();
  }, []);

  return {
    sessions,
    selectedSessionId,
    isLoading,
    error,
    refreshSessions,
    refreshSession,
    createSession,
    deleteSession,
    selectSession,
    applySessionStatus,
    getRelativeTime,
    uploadSessionFile,
    listSessionDirectory,
    getSessionFile,
    getSessionFileUrl,
    fetchWorkDirs,
    fetchStartupDir,
  };
}
