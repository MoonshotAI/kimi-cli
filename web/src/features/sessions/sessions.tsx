import {
  memo,
  useCallback,
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
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { isMacOS } from "@/hooks/utils";

type SessionSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

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
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; sessionId: string; sessionTitle: string }>({
    open: false,
    sessionId: "",
    sessionTitle: "",
  });
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Session search state
  const [sessionSearch, setSessionSearch] = useState("");

  const newSessionShortcutModifier = isMacOS() ? "Cmd" : "Ctrl";

  const filteredSessions = sessionSearch.trim()
    ? sessions.filter((s) =>
        s.title.toLowerCase().includes(sessionSearch.toLowerCase()),
      )
    : sessions;

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
      setDeleteConfirm({
        open: true,
        sessionId: contextMenu.sessionId,
        sessionTitle: session?.title ?? "Unknown Session",
      });
      setContextMenu(null);
    }
  };

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

          {/* Session search */}
          <div className="px-2">
            <div className="relative">
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
          </div>

          <div className="flex-1 overflow-y-auto px-3 pb-4 pr-1">
            <ul className="space-y-2">
              {filteredSessions.map((session) => {
                const isActive = session.id === selectedSessionId;
                return (
                  <li key={session.id}>
                    <button
                      className={`w-full cursor-pointer text-left rounded-lg px-3 py-2 transition-colors ${
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
                      <p className="text-sm font-medium text-foreground line-clamp-2">
                        {session.title}
                      </p>
                      <span className="text-[10px] text-muted-foreground mt-1 block">
                        {session.updatedAt}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
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
