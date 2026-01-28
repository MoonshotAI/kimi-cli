import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatStatus } from "ai";
import { PromptInputProvider } from "@ai-elements";
import { toast } from "sonner";
import { PanelLeftOpen, PanelLeftClose } from "lucide-react";
import { cn } from "./lib/utils";
import { ChatWorkspaceContainer } from "./features/chat/chat-workspace-container";
import { SessionsSidebar } from "./features/sessions/sessions";
import { Toaster } from "./components/ui/sonner";
import { formatRelativeTime, isElectronMac } from "./hooks/utils";
import { useSessions } from "./hooks/useSessions";
import { ThemeToggle } from "./components/ui/theme-toggle";
import type { SessionStatus } from "./lib/api/models";
import { SettingsDialog } from "./features/settings/settings-dialog";

/**
 * Get session ID from URL search params
 */
function getSessionIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("session");
}

/**
 * Update URL with session ID without triggering page reload
 */
function updateUrlWithSession(sessionId: string | null): void {
  const url = new URL(window.location.href);
  if (sessionId) {
    url.searchParams.set("session", sessionId);
  } else {
    url.searchParams.delete("session");
  }
  window.history.replaceState({}, "", url.toString());
}

function App() {
  const sessionsHook = useSessions();

  const {
    sessions,
    selectedSessionId,
    createSession,
    deleteSession,
    selectSession,
    duplicateSession,
    uploadSessionFile,
    getSessionFile,
    getSessionFileUrl,
    listSessionDirectory,
    refreshSession,
    refreshSessions,
    applySessionStatus,
    fetchWorkDirs,
    fetchStartupDir,
    error: sessionsError,
  } = sessionsHook;

  const currentSession = useMemo(
    () => sessions.find((session) => session.sessionId === selectedSessionId),
    [sessions, selectedSessionId],
  );

  const [streamStatus, setStreamStatus] = useState<ChatStatus>("ready");

  // Sidebar state
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const handleCollapseSidebar = useCallback(() => {
    setIsSidebarCollapsed(true);
  }, []);

  // Track if we've restored session from URL
  const hasRestoredFromUrlRef = useRef(false);

  // Eagerly restore session from URL - don't wait for session list to load
  // This allows session content to load in parallel with the session list
  useEffect(() => {
    if (hasRestoredFromUrlRef.current) {
      return;
    }

    const urlSessionId = getSessionIdFromUrl();
    if (urlSessionId) {
      console.log("[App] Eagerly restoring session from URL:", urlSessionId);
      selectSession(urlSessionId);
    }
    hasRestoredFromUrlRef.current = true;
  }, [selectSession]);

  // Validate session exists once session list loads, clear URL if not found
  useEffect(() => {
    if (sessions.length === 0 || !selectedSessionId) {
      return;
    }

    const sessionExists = sessions.some(
      (s) => s.sessionId === selectedSessionId,
    );
    if (!sessionExists) {
      console.log("[App] Session from URL not found, clearing selection");
      updateUrlWithSession(null);
      selectSession("");
    }
  }, [sessions, selectedSessionId, selectSession]);

  // Update URL when selected session changes
  useEffect(() => {
    // Skip the initial render before URL restoration
    if (!hasRestoredFromUrlRef.current) {
      return;
    }
    updateUrlWithSession(selectedSessionId || null);
  }, [selectedSessionId]);

  // Show toast notifications for errors
  useEffect(() => {
    if (sessionsError) {
      toast.error("Session Error", {
        description: sessionsError,
      });
    }
  }, [sessionsError]);

  const handleStreamStatusChange = useCallback((nextStatus: ChatStatus) => {
    setStreamStatus(nextStatus);
  }, []);

  const handleSessionStatus = useCallback(
    (status: SessionStatus) => {
      applySessionStatus(status);

      if (status.state !== "idle") {
        return;
      }

      const reason = status.reason ?? "";
      if (!reason.startsWith("prompt_")) {
        return;
      }

      console.log(
        "[App] Prompt complete, refreshing session info:",
        status.sessionId,
      );
      refreshSession(status.sessionId);
    },
    [applySessionStatus, refreshSession],
  );

  const handleCreateSession = useCallback(
    async (workDir: string) => {
      await createSession(workDir);
    },
    [createSession],
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      await deleteSession(sessionId);
    },
    [deleteSession],
  );

  const handleDuplicateSession = useCallback(
    async (sessionId: string) => {
      await duplicateSession(sessionId);
    },
    [duplicateSession],
  );

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      selectSession(sessionId);
    },
    [selectSession],
  );

  const handleRefreshSessions = useCallback(async () => {
    await refreshSessions();
  }, [refreshSessions]);

  // Transform Session[] to SessionSummary[] for sidebar
  const sessionSummaries = useMemo(
    () =>
      sessions.map((session) => ({
        id: session.sessionId,
        title: session.title ?? "Untitled",
        updatedAt: formatRelativeTime(session.lastUpdated),
      })),
    [sessions],
  );

  const showElectronTitlebar = isElectronMac();

  return (
    <PromptInputProvider>
      <div className={cn("app-page", showElectronTitlebar && "electron-app")}>
        {/* Electron macOS titlebar - provides drag region and space for traffic lights */}
        {showElectronTitlebar && <div className="electron-titlebar" />}
        <div className="app-shell max-w-none">
          <div
            className={cn(
              "grid min-h-0 flex-1 gap-2 -ml-2 sm:-ml-3",
              isSidebarCollapsed
                ? "grid-cols-[48px_minmax(0,1fr)]"
                : "grid-cols-[260px_minmax(0,1fr)]",
            )}
          >
            {/* Sidebar */}
            <div className="min-h-0 flex flex-col transition-all duration-200">
              {isSidebarCollapsed ? (
                /* Collapsed sidebar - vertical strip with logo and expand button */
                <div className="flex h-full flex-col items-center py-3">
                  <img src="/logo.png" alt="Kimi" className="size-6" />
                  <button
                    type="button"
                    aria-label="Expand sidebar"
                    className="mt-auto mb-1 inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
                    onClick={() => setIsSidebarCollapsed(false)}
                  >
                    <PanelLeftOpen className="size-4" />
                  </button>
                </div>
              ) : (
                /* Expanded sidebar */
                <div className="min-h-0 flex flex-col gap-3 h-full">
                  <SessionsSidebar
                    onCreateSession={handleCreateSession}
                    onDeleteSession={handleDeleteSession}
                    onSelectSession={handleSelectSession}
                    onDuplicateSession={handleDuplicateSession}
                    onRefreshSessions={handleRefreshSessions}
                    fetchWorkDirs={fetchWorkDirs}
                    fetchStartupDir={fetchStartupDir}
                    streamStatus={streamStatus}
                    selectedSessionId={selectedSessionId}
                    sessions={sessionSummaries}
                  />
                  <div className="mt-auto flex items-center justify-between pl-2 pb-2 pr-2">
                    <div className="flex items-center gap-2">
                      <ThemeToggle />
                      <SettingsDialog />
                    </div>
                    <button
                      type="button"
                      aria-label="Collapse sidebar"
                      className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
                      onClick={handleCollapseSidebar}
                    >
                      <PanelLeftClose className="size-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Main Chat Area */}
            <div className="relative flex min-h-0 justify-center">
              <ChatWorkspaceContainer
                selectedSessionId={selectedSessionId}
                currentSession={currentSession}
                sessionDescription={currentSession?.title}
                onSessionStatus={handleSessionStatus}
                onStreamStatusChange={handleStreamStatusChange}
                createSession={createSession}
                uploadSessionFile={uploadSessionFile}
                onListSessionDirectory={listSessionDirectory}
                onGetSessionFileUrl={getSessionFileUrl}
                onGetSessionFile={getSessionFile}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Toast notifications */}
      <Toaster position="top-right" richColors />
    </PromptInputProvider>
  );
}

export default App;
