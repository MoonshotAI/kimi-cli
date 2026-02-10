import type React from "react";
import {
  memo,
  useCallback,
  useMemo,
  type ReactElement,
  useEffect,
  useState,
  type MouseEvent,
  forwardRef,
  type ComponentPropsWithoutRef,
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
  Pencil,
  Loader2,
  Archive,
  ArchiveRestore,
  CheckSquare,
  Square,
  PanelLeftClose,
} from "lucide-react";
import { Virtuoso } from "react-virtuoso";
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
import { cn, } from "@/lib/utils";

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
  archivedSessions?: SessionSummary[];
  selectedSessionId: string;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onRenameSession?: (id: string, newTitle: string) => Promise<boolean>;
  onArchiveSession?: (id: string) => Promise<boolean>;
  onUnarchiveSession?: (id: string) => Promise<boolean>;
  onBulkArchiveSessions?: (sessionIds: string[]) => Promise<number>;
  onBulkUnarchiveSessions?: (sessionIds: string[]) => Promise<number>;
  onBulkDeleteSessions?: (sessionIds: string[]) => Promise<number>;
  onRefreshSessions?: () => Promise<void> | void;
  onRefreshArchivedSessions?: () => Promise<void> | void;
  onLoadMoreSessions?: () => Promise<void> | void;
  onLoadMoreArchivedSessions?: () => Promise<void> | void;
  hasMoreSessions?: boolean;
  hasMoreArchivedSessions?: boolean;
  isLoadingMore?: boolean;
  isLoadingMoreArchived?: boolean;
  isLoadingArchived?: boolean;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onOpenCreateDialog: () => void;
  onClose?: () => void;
  streamStatus?: "ready" | "streaming" | "submitted" | "error";
};

type ContextMenuState = {
  sessionId: string;
  x: number;
  y: number;
};

function SessionsScrollerComponent(
  props: ComponentPropsWithoutRef<"div">,
  ref: React.Ref<HTMLDivElement>,
) {
  const { className, ...rest } = props;
  return (
    <div
      ref={ref}
      className={cn(
        "flex-1 overflow-y-auto overflow-x-hidden [-webkit-overflow-scrolling:touch]  pb-4 pr-1",
        className,
      )}
      {...rest}
    />
  );
}

function SessionsListComponent(
  props: ComponentPropsWithoutRef<"div">,
  ref: React.Ref<HTMLDivElement>,
) {
  const { className, ...rest } = props;
  return (
    <div ref={ref} className={cn("flex flex-col space-y-0.5 w-full px-2 mt-1", className)} {...rest} />
  );
}

const SessionsScroller = forwardRef(SessionsScrollerComponent);
const SessionsList = forwardRef(SessionsListComponent);

SessionsScroller.displayName = "SessionsScroller";
SessionsList.displayName = "SessionsList";

export const SessionsSidebar = memo(function SessionsSidebarComponent({
  sessions,
  archivedSessions = [],
  selectedSessionId,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onArchiveSession,
  onUnarchiveSession,
  onBulkArchiveSessions,
  onBulkUnarchiveSessions,
  onBulkDeleteSessions,
  onRefreshSessions,
  onRefreshArchivedSessions,
  onLoadMoreSessions,
  onLoadMoreArchivedSessions,
  hasMoreSessions = false,
  hasMoreArchivedSessions = false,
  isLoadingMore = false,
  isLoadingMoreArchived = false,
  isLoadingArchived = false,
  searchQuery,
  onSearchQueryChange,
  onOpenCreateDialog,
  onClose,
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
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  // Session search state
  const [sessionSearch, setSessionSearch] = useState(searchQuery);

  // View mode state with localStorage persistence
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const stored = localStorage.getItem(VIEW_MODE_KEY);
    return stored === "grouped" ? "grouped" : "list";
  });

  // Archived section expanded state
  const [isArchivedExpanded, setIsArchivedExpanded] = useState(false);

  // Track if we're in the context menu of an archived session
  const [contextMenuIsArchived, setContextMenuIsArchived] = useState(false);

  // Multi-select state
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const [isMultiSelectArchived, setIsMultiSelectArchived] = useState(false); // true when selecting archived sessions
  const [isBulkOperating, setIsBulkOperating] = useState(false);

  useEffect(() => {
    setSessionSearch(searchQuery);
  }, [searchQuery]);

  // Load archived sessions when the section is expanded
  useEffect(() => {
    if (isArchivedExpanded && onRefreshArchivedSessions) {
      onRefreshArchivedSessions();
    }
  }, [isArchivedExpanded, onRefreshArchivedSessions]);

  // Exit multi-select mode when switching between archived/non-archived
  const exitMultiSelectMode = useCallback(() => {
    setIsMultiSelectMode(false);
    setSelectedSessionIds(new Set());
  }, []);

  const toggleSessionSelection = useCallback((sessionId: string) => {
    setSelectedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const toggleSelectAllSessions = useCallback((sessionList: SessionSummary[]) => {
    setSelectedSessionIds((prev) => {
      // If all are selected, deselect all
      if (prev.size === sessionList.length && sessionList.every((s) => prev.has(s.id))) {
        return new Set();
      }
      // Otherwise select all
      return new Set(sessionList.map((s) => s.id));
    });
  }, []);

  const handleBulkArchive = useCallback(async () => {
    if (!onBulkArchiveSessions || selectedSessionIds.size === 0) return;
    setIsBulkOperating(true);
    try {
      await onBulkArchiveSessions(Array.from(selectedSessionIds));
      exitMultiSelectMode();
    } finally {
      setIsBulkOperating(false);
    }
  }, [onBulkArchiveSessions, selectedSessionIds, exitMultiSelectMode]);

  const handleBulkUnarchive = useCallback(async () => {
    if (!onBulkUnarchiveSessions || selectedSessionIds.size === 0) return;
    setIsBulkOperating(true);
    try {
      await onBulkUnarchiveSessions(Array.from(selectedSessionIds));
      exitMultiSelectMode();
    } finally {
      setIsBulkOperating(false);
    }
  }, [onBulkUnarchiveSessions, selectedSessionIds, exitMultiSelectMode]);

  const handleBulkDelete = useCallback(async () => {
    if (!onBulkDeleteSessions || selectedSessionIds.size === 0) return;
    setIsBulkOperating(true);
    try {
      await onBulkDeleteSessions(Array.from(selectedSessionIds));
      exitMultiSelectMode();
    } finally {
      setIsBulkOperating(false);
    }
  }, [onBulkDeleteSessions, selectedSessionIds, exitMultiSelectMode]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      onSearchQueryChange(sessionSearch.trim());
    }, 300);
    return () => window.clearTimeout(handle);
  }, [sessionSearch, onSearchQueryChange]);

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
    isArchived = false,
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
    setContextMenuIsArchived(isArchived);
  };

  const handleMenuAction = async (action: "delete" | "rename" | "archive" | "unarchive" | "select-multiple") => {
    if (!contextMenu) {
      return;
    }

    const sessionId = contextMenu.sessionId;
    const isArchived = contextMenuIsArchived;
    setContextMenu(null);

    if (action === "delete") {
      const session = isArchived
        ? archivedSessions.find((s) => s.id === sessionId)
        : sessions.find((s) => s.id === sessionId);
      openDeleteConfirm(session);
    } else if (action === "rename") {
      const session = sessions.find((s) => s.id === sessionId);
      if (session) {
        setEditingSessionId(session.id);
        setEditingTitle(normalizeTitle(session.title));
      }
    } else if (action === "archive" && onArchiveSession) {
      await onArchiveSession(sessionId);
    } else if (action === "unarchive" && onUnarchiveSession) {
      await onUnarchiveSession(sessionId);
    } else if (action === "select-multiple") {
      setIsMultiSelectMode(true);
      setIsMultiSelectArchived(isArchived);
      setSelectedSessionIds(new Set([sessionId]));
    }
  };

  const handleSaveEdit = async () => {
    if (!(editingSessionId && onRenameSession)) {
      handleCancelEdit();
      return;
    }

    const trimmedTitle = editingTitle.trim();
    if (!trimmedTitle) {
      handleCancelEdit();
      return;
    }

    const success = await onRenameSession(editingSessionId, trimmedTitle);
    if (success) {
      handleCancelEdit();
    }
  };

  const handleCancelEdit = () => {
    setEditingSessionId(null);
    setEditingTitle("");
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

  const handleLoadMore = async () => {
    if (!onLoadMoreSessions || isLoadingMore || !hasMoreSessions) {
      return;
    }
    await Promise.resolve(onLoadMoreSessions());
  };

  const renderLoadMore = () => {
    if (!(hasMoreSessions || isLoadingMore)) {
      return null;
    }
    return (
      <div className="flex items-center justify-center py-2">
        {isLoadingMore ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={handleLoadMore}
          >
            Load more
          </button>
        )}
      </div>
    );
  };

  const renderContextMenu = () => {
    if (!contextMenu) {
      return null;
    }

    const hasBulkOperations = onBulkArchiveSessions || onBulkUnarchiveSessions || onBulkDeleteSessions;

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
        {/* Show Rename only for non-archived sessions */}
        {onRenameSession && !contextMenuIsArchived && (
          <button
            className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
            onClick={() => handleMenuAction("rename")}
            type="button"
          >
            <Pencil className="size-3.5" />
            Rename
          </button>
        )}
        {/* Show Archive for non-archived sessions */}
        {onArchiveSession && !contextMenuIsArchived && (
          <button
            className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
            onClick={() => handleMenuAction("archive")}
            type="button"
          >
            <Archive className="size-3.5" />
            Archive
          </button>
        )}
        {/* Show Unarchive for archived sessions */}
        {onUnarchiveSession && contextMenuIsArchived && (
          <button
            className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
            onClick={() => handleMenuAction("unarchive")}
            type="button"
          >
            <ArchiveRestore className="size-3.5" />
            Unarchive
          </button>
        )}
        {/* Show Select Multiple option */}
        {hasBulkOperations && (
          <button
            className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
            onClick={() => handleMenuAction("select-multiple")}
            type="button"
          >
            <CheckSquare className="size-3.5" />
            Select Multiple
          </button>
        )}
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
          <div className="flex items-center justify-between px-3 pt-2">
            <KimiCliBrand size="sm" showVersion={true} />
            {onClose && (
              <button
                type="button"
                aria-label="Close sidebar"
                className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
                onClick={onClose}
              >
                <PanelLeftClose className="size-4" />
              </button>
            )}
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

          {/* Multi-select action bar */}
          {isMultiSelectMode && (
            <div className="mx-2 flex items-center justify-between gap-2 rounded-md bg-secondary/80 px-2 py-1.5">
              {/* Left: checkbox toggle and count */}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                  onClick={() => toggleSelectAllSessions(isMultiSelectArchived ? archivedSessions : filteredSessions)}
                  disabled={isBulkOperating}
                  aria-label={selectedSessionIds.size === (isMultiSelectArchived ? archivedSessions : filteredSessions).length ? "Deselect all" : "Select all"}
                >
                  {selectedSessionIds.size === (isMultiSelectArchived ? archivedSessions : filteredSessions).length && selectedSessionIds.size > 0 ? (
                    <CheckSquare className="size-4" />
                  ) : (
                    <Square className="size-4" />
                  )}
                </button>
                <span className="text-xs text-muted-foreground">
                  {selectedSessionIds.size} selected
                </span>
              </div>
              {/* Right: action buttons */}
              <div className="flex items-center">
                {/* Archive/Unarchive button */}
                {isMultiSelectArchived ? (
                  onBulkUnarchiveSessions && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground transition-colors disabled:opacity-50"
                          onClick={handleBulkUnarchive}
                          disabled={isBulkOperating || selectedSessionIds.size === 0}
                        >
                          {isBulkOperating ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <ArchiveRestore className="size-4" />
                          )}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">Unarchive</TooltipContent>
                    </Tooltip>
                  )
                ) : (
                  onBulkArchiveSessions && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground transition-colors disabled:opacity-50"
                          onClick={handleBulkArchive}
                          disabled={isBulkOperating || selectedSessionIds.size === 0}
                        >
                          {isBulkOperating ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Archive className="size-4" />
                          )}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">Archive</TooltipContent>
                    </Tooltip>
                  )
                )}
                {/* Delete button */}
                {onBulkDeleteSessions && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-50"
                        onClick={handleBulkDelete}
                        disabled={isBulkOperating || selectedSessionIds.size === 0}
                      >
                        {isBulkOperating ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Trash2 className="size-4" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Delete</TooltipContent>
                  </Tooltip>
                )}
                {/* Divider */}
                <div className="mx-1 h-4 w-px bg-border" />
                {/* Cancel button */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground transition-colors"
                      onClick={exitMultiSelectMode}
                      disabled={isBulkOperating}
                    >
                      <X className="size-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Done</TooltipContent>
                </Tooltip>
              </div>
            </div>
          )}

          {/* Session search and view toggle */}
          {!isMultiSelectMode && (
          <div className="px-2 flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
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
              className="shrink-0"
            >
              <ToggleGroupItem value="list" aria-label="List view" title="List view" className="h-8 w-8 px-0">
                <List className="size-3.5" />
              </ToggleGroupItem>
              <ToggleGroupItem value="grouped" aria-label="Grouped view" title="Grouped by folder" className="h-8 w-8 px-0">
                <FolderTree className="size-3.5" />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          )}

          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex-1 min-h-0">
            {viewMode === "grouped" ? (
              <div className="flex h-full flex-col">
                <div className="flex-1 overflow-y-auto overflow-x-hidden [-webkit-overflow-scrolling:touch] px-3 pb-4 pr-1">
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
                                const isEditing = editingSessionId === session.id;
                                return (
                                  <li key={session.id}>
                                    <div className="flex w-full items-center gap-2">
                                      <button
                                        className={`flex-1 min-w-0 cursor-pointer text-left rounded-lg px-3 py-2 transition-colors ${
                                          isActive
                                            ? "bg-secondary"
                                            : "hover:bg-secondary/60"
                                        }`}
                                        onClick={() => !isEditing && onSelectSession(session.id)}
                                        onContextMenu={(event) =>
                                          !isEditing && handleSessionContextMenu(event, session.id)
                                        }
                                        type="button"
                                      >
                                        {isEditing ? (
                                          <input
                                            autoFocus
                                            value={editingTitle}
                                            onChange={(e) => setEditingTitle(e.target.value)}
                                            onBlur={handleSaveEdit}
                                            onKeyDown={(e) => {
                                              if (e.key === "Enter") {
                                                e.preventDefault();
                                                handleSaveEdit();
                                              }
                                              if (e.key === "Escape") {
                                                e.preventDefault();
                                                handleCancelEdit();
                                              }
                                            }}
                                            onClick={(e) => e.stopPropagation()}
                                            className="w-full text-sm font-medium text-foreground bg-background border border-input rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring"
                                          />
                                        ) : (
                                          <Tooltip delayDuration={500}>
                                            <TooltipTrigger asChild>
                                              <p className="text-sm font-medium text-foreground truncate">
                                                {normalizeTitle(session.title)}
                                              </p>
                                            </TooltipTrigger>
                                            <TooltipContent side="right" className="max-w-md">
                                              {normalizeTitle(session.title)}
                                            </TooltipContent>
                                          </Tooltip>
                                        )}
                                        {!isEditing && (
                                          <span className="text-[10px] text-muted-foreground mt-1 block">
                                            {session.updatedAt}
                                          </span>
                                        )}
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
                  {renderLoadMore()}
                </div>
              </div>
            ) : (
              <Virtuoso
                data={filteredSessions}
                className="h-full"
                computeItemKey={(_index, session) => session.id}
                components={{
                  Scroller: SessionsScroller,
                  List: SessionsList,
                  Footer: renderLoadMore,
                }}
                endReached={() => {
                  if (hasMoreSessions) {
                    handleLoadMore();
                  }
                }}
                itemContent={(_index, session) => {
                  const isActive = session.id === selectedSessionId;
                  const isEditing = editingSessionId === session.id;
                  const isSelected = isMultiSelectMode && !isMultiSelectArchived && selectedSessionIds.has(session.id);
                  const showCheckbox = isMultiSelectMode && !isMultiSelectArchived;
                  return (
                    <div className={`flex w-full items-center gap-2  transition-colors rounded-lg ${
                          isSelected
                            ? "bg-primary/10 ring-1 ring-primary/30"
                            : isActive
                            ? "bg-secondary"
                            : "hover:bg-secondary/60"
                        }`}>
                      {showCheckbox && (
                        <button
                          type="button"
                          className="ml-2 shrink-0 cursor-pointer"
                          onClick={() => toggleSessionSelection(session.id)}
                        >
                          {isSelected ? (
                            <CheckSquare className="size-4 text-primary" />
                          ) : (
                            <Square className="size-4 text-muted-foreground" />
                          )}
                        </button>
                      )}
                      <button
                        className={`flex-1 min-w-0 cursor-pointer text-left rounded-md px-2.5 py-1.5 transition-colors ${
                          showCheckbox ? "" : (isActive
                            ? "bg-secondary"
                            : "hover:bg-secondary/60")
                        }`}
                        onClick={() => {
                          if (showCheckbox) {
                            toggleSessionSelection(session.id);
                          } else if (!isEditing) {
                            onSelectSession(session.id);
                          }
                        }}
                        onContextMenu={(event) =>
                          !(isEditing || showCheckbox) && handleSessionContextMenu(event, session.id)
                        }
                        type="button"
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            value={editingTitle}
                            onChange={(e) => setEditingTitle(e.target.value)}
                            onBlur={handleSaveEdit}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                handleSaveEdit();
                              }
                              if (e.key === "Escape") {
                                e.preventDefault();
                                handleCancelEdit();
                              }
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full text-sm font-medium text-foreground bg-background border border-input rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring"
                          />
                        ) : (
                          <div className="flex items-center gap-2">
                            <Tooltip delayDuration={500}>
                              <TooltipTrigger asChild>
                                <p className="text-sm font-medium text-foreground truncate flex-1">
                                  {normalizeTitle(session.title)}
                                </p>
                              </TooltipTrigger>
                              <TooltipContent side="right" className="max-w-md">
                                {normalizeTitle(session.title)}
                              </TooltipContent>
                            </Tooltip>
                            <span className="text-[10px] text-muted-foreground shrink-0">
                              {session.updatedAt}
                            </span>
                          </div>
                        )}
                      </button>
                      {/* Mobile action buttons */}
                      {!showCheckbox && onArchiveSession && (
                        <button
                          type="button"
                          aria-label="Archive session"
                          className="md:hidden inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent"
                          onClick={(event) => {
                            event.stopPropagation();
                            onArchiveSession(session.id);
                          }}
                        >
                          <Archive className="size-3.5" />
                        </button>
                      )}
                      {!showCheckbox && (
                        <button
                          type="button"
                          aria-label="Delete session"
                          className="md:hidden inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                          onClick={(event) => {
                            event.stopPropagation();
                            openDeleteConfirm(session);
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </div>
                  );
                }}
              />
            )}
            </div>

            {/* Archived Sessions Section */}
            {(onArchiveSession || onUnarchiveSession) && (
              <div className="mx-2 mb-2 shrink-0 rounded-lg border border-border bg-muted/30">
                <Collapsible open={isArchivedExpanded} onOpenChange={setIsArchivedExpanded}>
                  <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground rounded-lg hover:bg-muted/50 group">
                    <ChevronDown className="size-3 transition-transform group-data-[state=closed]:-rotate-90" />
                    <Archive className="size-3" />
                    <span className="flex-1 text-left font-medium">Archived</span>
                    <span className="text-[10px] text-muted-foreground/70 bg-muted px-1.5 py-0.5 rounded">
                      {archivedSessions.length}
                    </span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    {isLoadingArchived ? (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="size-4 animate-spin text-muted-foreground" />
                      </div>
                    ) : archivedSessions.length === 0 ? (
                      <p className="px-3 py-3 text-xs text-muted-foreground">No archived sessions</p>
                    ) : (
                      <div className="space-y-1 px-1 pb-2 max-h-[50vh] overflow-y-auto">
                        <ul className="space-y-1">
                          {archivedSessions.map((session) => {
                            const isActive = session.id === selectedSessionId;
                            const isSelected = isMultiSelectMode && isMultiSelectArchived && selectedSessionIds.has(session.id);
                            const showCheckbox = isMultiSelectMode && isMultiSelectArchived;
                            return (
                              <li key={session.id}>
                                <div className={`flex w-full items-center gap-2 rounded-lg transition-colors ${
                                  isSelected
                                    ? "bg-primary/10 ring-1 ring-primary/30"
                                    : ""
                                }`}>
                                  {showCheckbox && (
                                    <button
                                      type="button"
                                      className="ml-2 shrink-0 cursor-pointer"
                                      onClick={() => toggleSessionSelection(session.id)}
                                    >
                                      {isSelected ? (
                                        <CheckSquare className="size-4 text-primary" />
                                      ) : (
                                        <Square className="size-4 text-muted-foreground" />
                                      )}
                                    </button>
                                  )}
                                  <button
                                    className={`flex-1 min-w-0 cursor-pointer text-left rounded-md px-2.5 py-1.5 transition-colors ${
                                      showCheckbox ? "" : (isActive
                                        ? "bg-secondary"
                                        : "hover:bg-secondary/60")
                                    }`}
                                    onClick={() => {
                                      if (showCheckbox) {
                                        toggleSessionSelection(session.id);
                                      } else {
                                        onSelectSession(session.id);
                                      }
                                    }}
                                    onContextMenu={(event) =>
                                      !showCheckbox && handleSessionContextMenu(event, session.id, true)
                                    }
                                    type="button"
                                  >
                                    <div className="flex items-center gap-2">
                                      <Tooltip delayDuration={500}>
                                        <TooltipTrigger asChild>
                                          <p className="text-sm font-medium text-foreground truncate flex-1 opacity-70">
                                            {normalizeTitle(session.title)}
                                          </p>
                                        </TooltipTrigger>
                                        <TooltipContent side="right" className="max-w-md">
                                          {normalizeTitle(session.title)}
                                        </TooltipContent>
                                      </Tooltip>
                                      <span className="text-[10px] text-muted-foreground shrink-0">
                                        {session.updatedAt}
                                      </span>
                                    </div>
                                  </button>
                                  {/* Mobile action buttons for archived sessions */}
                                  {!showCheckbox && onUnarchiveSession && (
                                    <button
                                      type="button"
                                      aria-label="Unarchive session"
                                      className="md:hidden inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        onUnarchiveSession(session.id);
                                      }}
                                    >
                                      <ArchiveRestore className="size-3.5" />
                                    </button>
                                  )}
                                  {!showCheckbox && (
                                    <button
                                      type="button"
                                      aria-label="Delete session"
                                      className="md:hidden inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        openDeleteConfirm(session);
                                      }}
                                    >
                                      <Trash2 className="size-3.5" />
                                    </button>
                                  )}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                        {/* Load more archived sessions */}
                        {(hasMoreArchivedSessions || isLoadingMoreArchived) && (
                          <div className="flex items-center justify-center py-2">
                            {isLoadingMoreArchived ? (
                              <Loader2 className="size-4 animate-spin text-muted-foreground" />
                            ) : (
                              <button
                                type="button"
                                className="text-xs text-muted-foreground hover:text-foreground"
                                onClick={() => onLoadMoreArchivedSessions?.()}
                              >
                                Load more
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              </div>
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
