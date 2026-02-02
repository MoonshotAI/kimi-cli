import {
  memo,
  useCallback,
  useMemo,
  type ReactElement,
  useEffect,
  useState,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Plus,
  Trash2,
  Search,
  X,
  AlertTriangle,
  RefreshCw,
  List,
  FolderTree,
  ChevronDown,
} from "lucide-react";
import { KimiCliBrand } from "@/components/kimi-cli-brand";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { isMacOS } from "@/hooks/utils";
import { shortenTitle } from "@/lib/utils";

// Top-level regex constants for performance
const NEWLINE_REGEX = /\r\n|\r|\n/;
const WHITESPACE_REGEX = /\s+/g;

type SessionSummary = {
  id: string;
  title: string;
  updatedAt: string;
  workDir?: string | null;
  lastUpdated: Date;
};

type ViewMode = "list" | "grouped";

type SessionGroup = {
  workDir: string;
  displayName: string;
  sessions: SessionSummary[];
};

const VIEW_MODE_KEY = "kimi-sessions-view-mode";

/**
 * Shorten a path to fit in limited space
 */
function shortenPath(path: string, maxLen = 30): string {
  if (path.length <= maxLen) return path;
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return ".../" + parts.slice(-2).join("/");
}

type SessionsSidebarProps = {
  sessions: SessionSummary[];
  selectedSessionId: string;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onRefreshSessions?: () => Promise<void> | void;
  onOpenCreateDialog: () => void;
  streamStatus?: "ready" | "streaming" | "submitted" | "error";
};

type ContextMenuState = {
  sessionId: string;
  x: number;
  y: number;
};

export const SessionsSidebar = memo(function SessionsSidebarComponent({
  sessions,
  selectedSessionId,
  onSelectSession,
  onDeleteSession,
  onRefreshSessions,
  onOpenCreateDialog,
}: SessionsSidebarProps): ReactElement {
  const minimumSpinMs = 600;
  const normalizeTitle = useCallback((t: string) => {
    // Split by any newline, join with space, then collapse whitespace
    return String(t)
      .split(NEWLINE_REGEX)
      .join(" ")
      .replace(WHITESPACE_REGEX, " ")
      .trim();
  }, []);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; sessionId: string; sessionTitle: string }>({
    open: false,
    sessionId: "",
    sessionTitle: "",
  });
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Session search state
  const [sessionSearch, setSessionSearch] = useState("");

  // View mode state with localStorage persistence
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const stored = localStorage.getItem(VIEW_MODE_KEY);
    return stored === "grouped" ? "grouped" : "list";
  });

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    localStorage.setItem(VIEW_MODE_KEY, mode);
  }, []);

  const newSessionShortcutModifier = isMacOS() ? "Cmd" : "Ctrl";

  // Enhanced search: support both title and workDir
  const filteredSessions = useMemo(() => {
    const search = sessionSearch.trim().toLowerCase();
    if (!search) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(search) ||
        s.workDir?.toLowerCase().includes(search)
    );
  }, [sessions, sessionSearch]);

  // Group sessions by workDir
  const sessionGroups = useMemo((): SessionGroup[] => {
    if (viewMode !== "grouped") return [];

    const groups = new Map<string, SessionSummary[]>();
    for (const session of filteredSessions) {
      const key = session.workDir || "__other__";
      const existing = groups.get(key) || [];
      groups.set(key, [...existing, session]);
    }

    return Array.from(groups.entries())
      .map(([key, items]) => ({
        workDir: key,
        displayName: key === "__other__" ? "Other" : shortenPath(key),
        sessions: items,
      }))
      .sort((a, b) => {
        // "Other" always at bottom
        if (a.workDir === "__other__") return 1;
        if (b.workDir === "__other__") return -1;

        // Sort by latest session time (newest first)
        const aLatest = Math.max(...a.sessions.map(s => s.lastUpdated.getTime()));
        const bLatest = Math.max(...b.sessions.map(s => s.lastUpdated.getTime()));
        return bLatest - aLatest;
      });
  }, [filteredSessions, viewMode]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const closeMenu = () => {
      setContextMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };

    window.addEventListener("click", closeMenu);
    window.addEventListener("contextmenu", closeMenu);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("contextmenu", closeMenu);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  const handleSessionContextMenu = (
    event: MouseEvent<HTMLButtonElement>,
    sessionId: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const menuWidth = 200;
    const menuHeight = 32;
    const padding = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const proposedX =
      event.clientX + menuWidth + padding > viewportWidth
        ? viewportWidth - menuWidth - padding
        : event.clientX;
    const proposedY =
      event.clientY + menuHeight + padding > viewportHeight
        ? viewportHeight - menuHeight - padding
        : event.clientY;

    setContextMenu({
      sessionId,
      x: Math.max(padding, proposedX),
      y: Math.max(padding, proposedY),
    });
  };

  const handleMenuAction = (action: "delete") => {
    if (!contextMenu) {
      return;
    }

    if (action === "delete") {
      const session = sessions.find((s) => s.id === contextMenu.sessionId);
      openDeleteConfirm(session);
      setContextMenu(null);
    }
  };

  const openDeleteConfirm = useCallback(
    (session?: SessionSummary) => {
      if (!session) {
        return;
      }
      setDeleteConfirm({
        open: true,
        sessionId: session.id,
        sessionTitle: normalizeTitle(session.title ?? "Unknown Session"),
      });
    },
    [normalizeTitle],
  );

  const handleConfirmDelete = () => {
    if (deleteConfirm.sessionId) {
      onDeleteSession(deleteConfirm.sessionId);
    }
    setDeleteConfirm({ open: false, sessionId: "", sessionTitle: "" });
  };

  const handleCancelDelete = () => {
    setDeleteConfirm({ open: false, sessionId: "", sessionTitle: "" });
  };

  const handleRefreshSessions = async () => {
    if (!onRefreshSessions || isRefreshing) {
      return;
    }
    setIsRefreshing(true);
    const startedAt = Date.now();
    try {
      await Promise.resolve(onRefreshSessions());
    } finally {
      const elapsed = Date.now() - startedAt;
      if (elapsed < minimumSpinMs) {
        await new Promise((resolve) => setTimeout(resolve, minimumSpinMs - elapsed));
      }
      setIsRefreshing(false);
    }
  };

  const renderContextMenu = () => {
    if (!contextMenu) {
      return null;
    }

    const menu = (
      <div
        className="fixed z-120 min-w-40 rounded-md border border-border bg-popover p-1 text-sm shadow-md"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
          }
        }}
        role="menu"
        style={{ top: contextMenu.y, left: contextMenu.x }}
      >
        <button
          className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-destructive hover:bg-destructive/10"
          onClick={() => handleMenuAction("delete")}
          type="button"
        >
          <Trash2 className="size-3.5" />
          Delete session
        </button>
      </div>
    );

    return typeof document === "undefined"
      ? menu
      : createPortal(menu, document.body);
  };

  return (
    <>
      <aside className="flex h-full min-h-0 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
          <div className="flex items-center justify-between px-3">
            <KimiCliBrand size="sm" showVersion={true} />
          </div>

          {/* Sessions */}
          <div className="flex items-center justify-between px-3 pt-3">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Sessions</h4>
            <div className="flex items-center gap-1">
              <button
                aria-label="Refresh sessions"
                className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
                onClick={handleRefreshSessions}
                disabled={isRefreshing || !onRefreshSessions}
                aria-busy={isRefreshing}
                title="Refresh Sessions"
                type="button"
              >
                <RefreshCw className={`size-4 ${isRefreshing ? "animate-spin" : ""}`} />
              </button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-label="New Session"
                    className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={onOpenCreateDialog}
                    type="button"
                  >
                    <Plus className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="flex items-center gap-2" side="bottom">
                  <span>New session</span>
                  <KbdGroup>
                    <Kbd>Shift</Kbd>
                    <span className="text-muted-foreground">+</span>
                    <Kbd>{newSessionShortcutModifier}</Kbd>
                    <span className="text-muted-foreground">+</span>
                    <Kbd>O</Kbd>
                  </KbdGroup>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* Session search and view toggle */}
          <div className="px-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search sessions..."
                value={sessionSearch}
                onChange={(e) => setSessionSearch(e.target.value)}
                className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-8 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {sessionSearch && (
                <button
                  type="button"
                  onClick={() => setSessionSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            <ToggleGroup
              type="single"
              variant="outline"
              value={viewMode}
              onValueChange={(value) => value && handleViewModeChange(value as ViewMode)}
            >
              <ToggleGroupItem value="list" aria-label="List view" title="List view" className="h-8 w-8 px-0">
                <List className="size-3.5" />
              </ToggleGroupItem>
              <ToggleGroupItem value="grouped" aria-label="Grouped view" title="Grouped by folder" className="h-8 w-8 px-0">
                <FolderTree className="size-3.5" />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          <div className="flex-1 overflow-y-auto [-webkit-overflow-scrolling:touch] px-3 pb-4 pr-1">
            {viewMode === "grouped" ? (
              <ul className="space-y-1">
                {sessionGroups.map((group) => (
                  <li key={group.workDir}>
                    <Collapsible defaultOpen={group.sessions.some(s => s.id === selectedSessionId)}>
                      <CollapsibleTrigger className="flex w-full items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-secondary/50 group">
                        <ChevronDown className="size-3 transition-transform group-data-[state=closed]:-rotate-90" />
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="flex-1 truncate text-left font-medium">
                              {group.displayName}
                            </span>
                          </TooltipTrigger>
                          {group.workDir !== "__other__" && (
                            <TooltipContent
                              side="right"
                            >
                              {group.workDir}
                            </TooltipContent>
                          )}
                        </Tooltip>
                        <span className="text-[10px] text-muted-foreground">
                          ({group.sessions.length})
                        </span>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <ul className="pl-3 space-y-1 mt-1">
                          {group.sessions.map((session) => {
                            const isActive = session.id === selectedSessionId;
                            return (
                              <li key={session.id}>
                                <div className="flex items-center gap-2 ">
                                  <button
                                    className={`w-full flex-1 cursor-pointer text-left rounded-lg px-3 py-2 transition-colors ${
                                      isActive
                                        ? "bg-secondary"
                                        : "hover:bg-secondary/60"
                                    }`}
                                    onClick={() => onSelectSession(session.id)}
                                    onContextMenu={(event) =>
                                      handleSessionContextMenu(event, session.id)
                                    }
                                    type="button"
                                  >
                                    <Tooltip delayDuration={500}>
                                      <TooltipTrigger asChild>
                                        <p className="text-sm font-medium text-foreground overflow-hidden">
                                          {shortenTitle(normalizeTitle(session.title), 50)}
                                        </p>
                                      </TooltipTrigger>
                                      <TooltipContent side="right" className="max-w-md">
                                        {normalizeTitle(session.title)}
                                      </TooltipContent>
                                    </Tooltip>
                                    <span className="text-[10px] text-muted-foreground mt-1 block">
                                      {session.updatedAt}
                                    </span>
                                  </button>
                                  <button
                                    type="button"
                                    aria-label="Delete session"
                                    className="md:hidden inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      openDeleteConfirm(session);
                                    }}
                                  >
                                    <Trash2 className="size-4" />
                                  </button>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </CollapsibleContent>
                    </Collapsible>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="space-y-2">
                {filteredSessions.map((session) => {
                  const isActive = session.id === selectedSessionId;
                  return (
                    <li key={session.id}>
                      <div className="flex items-center gap-2 min-w-0">
                        <button
                          className={`min-w-0 flex-1 cursor-pointer text-left rounded-lg px-3 py-2 transition-colors ${
                            isActive
                              ? "bg-secondary"
                              : "hover:bg-secondary/60"
                          }`}
                          onClick={() => onSelectSession(session.id)}
                          onContextMenu={(event) =>
                            handleSessionContextMenu(event, session.id)
                          }
                          type="button"
                        >
                          <Tooltip delayDuration={500}>
                            <TooltipTrigger asChild>
                              <p className="text-sm font-medium text-foreground overflow-hidden">
                                {shortenTitle(normalizeTitle(session.title), 50)}
                              </p>
                            </TooltipTrigger>
                            <TooltipContent side="right" className="max-w-md">
                              {normalizeTitle(session.title)}
                            </TooltipContent>
                          </Tooltip>
                          <span className="text-[10px] text-muted-foreground mt-1 block">
                            {session.updatedAt}
                          </span>
                        </button>
                        <button
                          type="button"
                          aria-label="Delete session"
                          className="md:hidden inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                          onClick={(event) => {
                            event.stopPropagation();
                            openDeleteConfirm(session);
                          }}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </aside>
      {renderContextMenu()}

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteConfirm.open} onOpenChange={(open) => !open && handleCancelDelete()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="size-5" />
              Delete Session
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong className="text-foreground">{deleteConfirm.sessionTitle}</strong>?
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 w-full justify-end">
            <Button variant="outline" onClick={handleCancelDelete}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});
