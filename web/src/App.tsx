import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatStatus } from "ai";
import { PromptInputProvider } from "@ai-elements";
import { toast } from "sonner";
import { PanelLeftOpen, PanelLeftClose } from "lucide-react";
import { cn } from "./lib/utils";
import { ResizablePanel, ResizablePanelGroup } from "./components/ui/resizable";
import { ChatWorkspaceContainer } from "./features/chat/chat-workspace-container";
import { SessionsSidebar } from "./features/sessions/sessions";
import { CreateSessionDialog } from "./features/sessions/create-session-dialog";
import { Toaster } from "./components/ui/sonner";
import { formatRelativeTime } from "./hooks/utils";
import { useSessions } from "./hooks/useSessions";
import { useTheme } from "./hooks/use-theme";
import { ThemeToggle } from "./components/ui/theme-toggle";
import type { SessionStatus } from "./lib/api/models";
import type { PanelSize, PanelImperativeHandle } from "react-resizable-panels";
import { consumeAuthTokenFromUrl, setAuthToken } from "./lib/auth";

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

const SIDEBAR_COLLAPSED_SIZE = 48;
const SIDEBAR_MIN_SIZE = 200;
const SIDEBAR_DEFAULT_SIZE = 260;
const SIDEBAR_ANIMATION_MS = 250;

function App() {
  // Initialize theme on app startup
  useTheme();

  const sidebarElementRef = useRef<HTMLDivElement | null>(null);
  const sidebarPanelRef = useRef<PanelImperativeHandle | null>(null);
  const sessionsHook = useSessions();
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === "undefined") {
      return true;
    }
    return window.matchMedia("(min-width: 1024px)").matches;
  });

  const {
    sessions,
    archivedSessions,
    selectedSessionId,
    createSession,
    deleteSession,
    selectSession,
    uploadSessionFile,
    getSessionFile,
    getSessionFileUrl,
    listSessionDirectory,
    refreshSession,
    refreshSessions,
    refreshArchivedSessions,
    loadMoreSessions,
    loadMoreArchivedSessions,
    hasMoreSessions,
    hasMoreArchivedSessions,
    isLoadingMore,
    isLoadingMoreArchived,
    isLoadingArchived,
    searchQuery,
    setSearchQuery,
    applySessionStatus,
    fetchWorkDirs,
    fetchStartupDir,
    renameSession,
    generateTitle,
    archiveSession,
    unarchiveSession,
    bulkArchiveSessions,
    bulkUnarchiveSessions,
    bulkDeleteSessions,
    forkSession,
    error: sessionsError,
  } = sessionsHook;

  const currentSession = useMemo(
    () => sessions.find((session) => session.sessionId === selectedSessionId),
    [sessions, selectedSessionId],
  );

  const [streamStatus, setStreamStatus] = useState<ChatStatus>("ready");

  useEffect(() => {
    const token = consumeAuthTokenFromUrl();
    if (token) {
      setAuthToken(token);
    }
  }, []);

  // Create session dialog state (lifted to App for unified access)
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const handleOpenCreateDialog = useCallback(() => {
    setShowCreateDialog(true);
    setIsMobileSidebarOpen(false);
  }, []);

  const handleOpenMobileSidebar = useCallback(() => {
    setIsMobileSidebarOpen(true);
  }, []);

  const handleCloseMobileSidebar = useCallback(() => {
    setIsMobileSidebarOpen(false);
  }, []);

  // Sidebar state
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isSidebarAnimating, setIsSidebarAnimating] = useState(false);
  const handleCollapseSidebar = useCallback(() => {
    setIsSidebarAnimating(true);
    sidebarPanelRef.current?.collapse();
  }, []);
  const handleExpandSidebar = useCallback(() => {
    setIsSidebarAnimating(true);
    sidebarPanelRef.current?.expand();
  }, []);
  const handleSidebarResize = useCallback((panelSize: PanelSize) => {
    const collapsed = panelSize.inPixels <= SIDEBAR_COLLAPSED_SIZE + 1;
    setIsSidebarCollapsed((prev) => (prev === collapsed ? prev : collapsed));
  }, []);

  useEffect(() => {
    if (!isSidebarAnimating) {
      return;
    }
    const timer = window.setTimeout(() => {
      setIsSidebarAnimating(false);
    }, SIDEBAR_ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, [isSidebarAnimating]);

  useEffect(() => {
    const current = sidebarPanelRef.current;
    if (!current) {
      return;
    }
    setIsSidebarCollapsed(current.isCollapsed());
  }, []);

  useEffect(() => {
    const element = sidebarElementRef.current;
    if (!element) {
      return;
    }
    if (isSidebarAnimating) {
      element.style.transition = `flex-basis ${SIDEBAR_ANIMATION_MS}ms ease-in-out`;
      return;
    }
    element.style.transition = "";
  }, [isSidebarAnimating]);

  // Track layout breakpoint and close mobile sidebar when switching to desktop
  useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 1024px)");
    const handleChange = () => {
      const matches = mediaQuery.matches;
      setIsDesktop(matches);
      if (matches) setIsMobileSidebarOpen(false);
    };
    handleChange();
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
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

    if (searchQuery.trim() || hasMoreSessions) {
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
  }, [sessions, selectedSessionId, selectSession, hasMoreSessions, searchQuery]);

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
    async (workDir: string, createDir?: boolean) => {
      await createSession(workDir, createDir);
    },
    [createSession],
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      await deleteSession(sessionId);
    },
    [deleteSession],
  );

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      selectSession(sessionId);
      setIsMobileSidebarOpen(false);
    },
    [selectSession],
  );

  const handleRefreshSessions = useCallback(async () => {
    await refreshSessions();
  }, [refreshSessions]);

  const handleSearchQueryChange = useCallback(
    (query: string) => {
      setSearchQuery(query);
    },
    [setSearchQuery],
  );

  // Transform Session[] to SessionSummary[] for sidebar
  const sessionSummaries = useMemo(
    () =>
      sessions.map((session) => ({
        id: session.sessionId,
        title: session.title ?? "Untitled",
        updatedAt: formatRelativeTime(session.lastUpdated),
        workDir: session.workDir,
        lastUpdated: session.lastUpdated,
      })),
    [sessions],
  );

  // Transform archived Session[] to SessionSummary[] for sidebar
  const archivedSessionSummaries = useMemo(
    () =>
      archivedSessions.map((session) => ({
        id: session.sessionId,
        title: session.title ?? "Untitled",
        updatedAt: formatRelativeTime(session.lastUpdated),
        workDir: session.workDir,
        lastUpdated: session.lastUpdated,
      })),
    [archivedSessions],
  );

  const handleForkSession = useCallback(
    async (sessionId: string, turnIndex: number) => {
      await forkSession(sessionId, turnIndex);
    },
    [forkSession],
  );

  const renderChatPanel = () => (
    <ChatWorkspaceContainer
      selectedSessionId={selectedSessionId}
      currentSession={currentSession}
      sessionDescription={currentSession?.title}
      onSessionStatus={handleSessionStatus}
      onStreamStatusChange={handleStreamStatusChange}
      uploadSessionFile={uploadSessionFile}
      onListSessionDirectory={listSessionDirectory}
      onGetSessionFileUrl={getSessionFileUrl}
      onGetSessionFile={getSessionFile}
      onOpenCreateDialog={handleOpenCreateDialog}
      onOpenSidebar={handleOpenMobileSidebar}
      generateTitle={generateTitle}
      onRenameSession={renameSession}
      onForkSession={handleForkSession}
    />
  );

  return (
    <PromptInputProvider>
      <div className="box-border flex h-[100dvh] flex-col bg-background text-foreground px-[calc(0.75rem+var(--safe-left))] pr-[calc(0.75rem+var(--safe-right))] pt-[calc(0.75rem+var(--safe-top))] pb-1 lg:pb-[calc(0.75rem+var(--safe-bottom))] max-lg:h-[100svh] max-lg:overflow-hidden">
        <div className="mx-auto flex h-full min-h-0 w-full flex-1 flex-col gap-2 max-w-none">
          {isDesktop ? (
            <ResizablePanelGroup
              orientation="horizontal"
              className="min-h-0 flex-1 overflow-hidden"
            >
              {/* Sidebar */}
              <ResizablePanel
                id="sessions"
                collapsible
                collapsedSize={SIDEBAR_COLLAPSED_SIZE}
                defaultSize={SIDEBAR_DEFAULT_SIZE}
                minSize={SIDEBAR_MIN_SIZE}
                elementRef={sidebarElementRef}
                panelRef={sidebarPanelRef}
                onResize={handleSidebarResize}
                className={cn("relative min-h-0 border-r pl-0.5 pr-2 overflow-hidden")}
              >
                {/* Collapsed sidebar - vertical strip with logo and expand button */}
                <div
                  className={cn(
                    "absolute inset-0 flex h-full flex-col items-center py-3 transition-all duration-200 ease-in-out",
                    isSidebarCollapsed
                      ? "opacity-100 translate-x-0"
                      : "opacity-0 -translate-x-2 pointer-events-none select-none",
                  )}
                >
                  <a
                    href="https://www.kimi.com/code"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:opacity-80 transition-opacity"
                  >
                    <img
                      src="/logo.png"
                      alt="Kimi"
                      width={24}
                      height={24}
                      className="size-6"
                    />
                  </a>
                  <button
                    type="button"
                    aria-label="Expand sidebar"
                    className="mt-auto mb-1 inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
                    onClick={handleExpandSidebar}
                  >
                    <PanelLeftOpen className="size-4" />
                  </button>
                </div>
                {/* Expanded sidebar */}
                <div
                  className={cn(
                    "absolute inset-0 flex h-full min-h-0 flex-col gap-3 transition-all duration-200 ease-in-out",
                    isSidebarCollapsed
                      ? "opacity-0 translate-x-2 pointer-events-none select-none"
                      : "opacity-100 translate-x-0",
                  )}
                >
                  <SessionsSidebar
                    onDeleteSession={handleDeleteSession}
                    onSelectSession={handleSelectSession}
                    onRenameSession={renameSession}
                    onArchiveSession={archiveSession}
                    onUnarchiveSession={unarchiveSession}
                    onBulkArchiveSessions={bulkArchiveSessions}
                    onBulkUnarchiveSessions={bulkUnarchiveSessions}
                    onBulkDeleteSessions={bulkDeleteSessions}
                    onRefreshSessions={handleRefreshSessions}
                    onRefreshArchivedSessions={refreshArchivedSessions}
                    onLoadMoreSessions={loadMoreSessions}
                    onLoadMoreArchivedSessions={loadMoreArchivedSessions}
                    onOpenCreateDialog={handleOpenCreateDialog}
                    streamStatus={streamStatus}
                    selectedSessionId={selectedSessionId}
                    sessions={sessionSummaries}
                    archivedSessions={archivedSessionSummaries}
                    hasMoreSessions={hasMoreSessions}
                    hasMoreArchivedSessions={hasMoreArchivedSessions}
                    isLoadingMore={isLoadingMore}
                    isLoadingMoreArchived={isLoadingMoreArchived}
                    isLoadingArchived={isLoadingArchived}
                    searchQuery={searchQuery}
                    onSearchQueryChange={handleSearchQueryChange}
                  />
                  <div className="mt-auto flex items-center justify-between pl-2 pb-2 pr-2">
                    <div className="flex items-center gap-2">
                      <ThemeToggle />
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
              </ResizablePanel>

              {/* Main Chat Area */}
              <ResizablePanel id="chat" className="relative min-h-0 flex justify-center flex-1">
                {renderChatPanel()}
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              {renderChatPanel()}
            </div>
          )}
        </div>
      </div>

      {/* Toast notifications */}
      <Toaster position="top-right" richColors />

      {/* Create Session Dialog - unified for sidebar button and keyboard shortcut */}
      <CreateSessionDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onConfirm={handleCreateSession}
        fetchWorkDirs={fetchWorkDirs}
        fetchStartupDir={fetchStartupDir}
      />

      {/* Mobile Sessions Sidebar */}
      {isMobileSidebarOpen ? (
        <div className="fixed inset-0 z-50 flex lg:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close sessions sidebar"
            onClick={handleCloseMobileSidebar}
          />
          <div className="relative flex h-full w-[min(86vw,360px)] flex-col border-r border-border bg-background pt-[var(--safe-top)] shadow-2xl">
            <div className="min-h-0 flex-1">
              <SessionsSidebar
                onDeleteSession={handleDeleteSession}
                onSelectSession={handleSelectSession}
                onRenameSession={renameSession}
                onArchiveSession={archiveSession}
                onUnarchiveSession={unarchiveSession}
                onBulkArchiveSessions={bulkArchiveSessions}
                onBulkUnarchiveSessions={bulkUnarchiveSessions}
                onBulkDeleteSessions={bulkDeleteSessions}
                onRefreshSessions={handleRefreshSessions}
                onRefreshArchivedSessions={refreshArchivedSessions}
                onLoadMoreSessions={loadMoreSessions}
                onLoadMoreArchivedSessions={loadMoreArchivedSessions}
                onOpenCreateDialog={handleOpenCreateDialog}
                onClose={handleCloseMobileSidebar}
                streamStatus={streamStatus}
                selectedSessionId={selectedSessionId}
                sessions={sessionSummaries}
                archivedSessions={archivedSessionSummaries}
                hasMoreSessions={hasMoreSessions}
                hasMoreArchivedSessions={hasMoreArchivedSessions}
                isLoadingMore={isLoadingMore}
                isLoadingMoreArchived={isLoadingMoreArchived}
                isLoadingArchived={isLoadingArchived}
                searchQuery={searchQuery}
                onSearchQueryChange={handleSearchQueryChange}
              />
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2">
              <ThemeToggle />
            </div>
          </div>
        </div>
      ) : null}
    </PromptInputProvider>
  );
}

export default App;
