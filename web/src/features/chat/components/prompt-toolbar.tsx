import {
  type KeyboardEvent,
  type ReactElement,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileIcon,
  FolderOpenIcon,
  CodeIcon,
  AppWindowIcon,
  GitBranchIcon,
  ListOrderedIcon,
  PencilIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getAuthHeader } from "@/lib/auth";
import { isMacOS } from "@/hooks/utils";
import type { GitDiffStats } from "@/lib/api/models";
import { useQueueStore, type QueuedItem } from "../queue-store";

// ─── Types ───────────────────────────────────────────────────

type TabId = "queue" | "changes";

type PromptToolbarProps = {
  gitDiffStats?: GitDiffStats | null;
  isGitDiffLoading?: boolean;
  workDir?: string | null;
};

// ─── Open-in helpers (from git-diff-status-bar) ──────────────

type OpenTarget = {
  id: string;
  label: string;
  icon: ReactElement;
  backendApp: "finder" | "cursor" | "vscode";
};

const OPEN_TARGETS: OpenTarget[] = [
  { id: "finder", label: "Finder", icon: <FolderOpenIcon className="size-3.5" />, backendApp: "finder" },
  { id: "cursor", label: "Cursor", icon: <AppWindowIcon className="size-3.5" />, backendApp: "cursor" },
  { id: "vscode", label: "VS Code", icon: <CodeIcon className="size-3.5" />, backendApp: "vscode" },
];

const TRAILING_SLASHES_REGEX = /\/+$/;

async function openViaBackend(app: OpenTarget["backendApp"], path: string) {
  const response = await fetch("/api/open-in", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeader() },
    body: JSON.stringify({ app, path }),
  });
  if (!response.ok) {
    let detail = "Failed to open application.";
    try {
      const data = await response.json();
      if (data?.detail) detail = String(data.detail);
    } catch { /* ignore */ }
    throw new Error(detail);
  }
}

function OpenInButton({ path, className }: { path: string; className?: string }) {
  const targets = useMemo(() => (isMacOS() ? OPEN_TARGETS : OPEN_TARGETS.filter((t) => t.id !== "finder")), []);

  const handleOpen = useCallback(async (target: OpenTarget, e: Event) => {
    e.stopPropagation();
    try { await openViaBackend(target.backendApp, path); }
    catch (error) { toast.error("Failed to open", { description: error instanceof Error ? error.message : "Unexpected error" }); }
  }, [path]);

  const handleCopyPath = useCallback(async (e: Event) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(path); toast.success("Path copied", { description: path }); }
    catch { toast.error("Failed to copy path"); }
  }, [path]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1.5 py-0.5",
            "text-[10px] font-medium text-muted-foreground",
            "bg-background/80 hover:bg-background hover:text-foreground",
            "border border-border/50 shadow-sm transition-all duration-150 cursor-pointer",
            className,
          )}
        >
          <ExternalLinkIcon className="size-2.5" />
          <span>Open</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[120px]" onClick={(e) => e.stopPropagation()}>
        {targets.map((target) => (
          <DropdownMenuItem key={target.id} onSelect={(e) => handleOpen(target, e)} className="text-xs">
            {target.icon}
            <span>{target.label}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleCopyPath} className="text-xs">
          <CopyIcon className="size-3.5" />
          <span>Copy path</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Queue panel sub-components ──────────────────────────────

function QueueItemRow({ item, isFirst, onEdit }: { item: QueuedItem; isFirst: boolean; onEdit: (id: string) => void }): ReactElement {
  const removeFromQueue = useQueueStore((s) => s.removeFromQueue);
  const moveQueueItemUp = useQueueStore((s) => s.moveQueueItemUp);

  return (
    <div className="group flex items-center gap-1.5 px-3 py-1.5 hover:bg-muted/50 transition-colors">
      <p className="min-w-0 text-xs text-foreground truncate leading-relaxed">
        {item.text}
      </p>
      <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="size-5" onClick={() => onEdit(item.id)}>
              <PencilIcon className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Edit</TooltipContent>
        </Tooltip>
        {!isFirst && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="size-5" onClick={() => moveQueueItemUp(item.id)}>
                <ArrowUpIcon className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Move up</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="size-5 text-muted-foreground hover:text-destructive" onClick={() => removeFromQueue(item.id)}>
              <Trash2Icon className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function EditingItemRow({ item, onDone }: { item: QueuedItem; onDone: () => void }): ReactElement {
  const [text, setText] = useState(item.text);
  const editQueueItem = useQueueStore((s) => s.editQueueItem);

  const handleSave = useCallback(() => {
    if (text.trim()) editQueueItem(item.id, text.trim());
    onDone();
  }, [text, item.id, editQueueItem, onDone]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); handleSave(); }
    if (e.key === "Escape") { e.preventDefault(); onDone(); }
  }, [handleSave, onDone]);

  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-muted/30">
      <input
        autoFocus
        aria-label="Edit queued message"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        className="flex-1 min-w-0 text-xs bg-transparent border-b border-border outline-none py-0.5"
      />
      <Button variant="ghost" size="icon-sm" className="size-5" onClick={handleSave}>
        <CheckIcon className="size-3" />
      </Button>
      <Button variant="ghost" size="icon-sm" className="size-5" onClick={onDone}>
        <XIcon className="size-3" />
      </Button>
    </div>
  );
}

// ─── Main toolbar ────────────────────────────────────────────

export const PromptToolbar = memo(function PromptToolbarComponent({
  gitDiffStats,
  isGitDiffLoading,
  workDir,
}: PromptToolbarProps): ReactElement | null {
  const queue = useQueueStore((s) => s.queue);
  const [activeTab, setActiveTab] = useState<TabId | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const prevQueueLenRef = useRef(0);

  const stats = gitDiffStats;
  const hasChanges = Boolean(stats?.isGitRepo && stats.hasChanges && stats.files && !stats.error);
  const hasQueue = queue.length > 0;
  const hasTabs = hasQueue || hasChanges;

  // Auto-open queue tab when first item is added
  useEffect(() => {
    if (prevQueueLenRef.current === 0 && queue.length > 0) {
      setActiveTab("queue");
    }
    prevQueueLenRef.current = queue.length;
  }, [queue.length]);

  // Auto-close tab when its data becomes empty
  useEffect(() => {
    if (activeTab === "queue" && !hasQueue) setActiveTab(null);
    if (activeTab === "changes" && !hasChanges) setActiveTab(null);
  }, [activeTab, hasQueue, hasChanges]);

  const toggleTab = useCallback((tab: TabId) => {
    setActiveTab((prev) => (prev === tab ? null : tab));
  }, []);

  const handleEditDone = useCallback(() => setEditingId(null), []);

  const getFilePath = useCallback(
    (relativePath: string) => {
      if (!workDir) return relativePath;
      return `${workDir.replace(TRAILING_SLASHES_REGEX, "")}/${relativePath}`;
    },
    [workDir],
  );

  if (!hasTabs) return null;

  return (
    <div className={cn("w-full px-1 sm:px-2 flex flex-col gap-1 mb-2", isGitDiffLoading && "opacity-70")}>
      {/* ── Expanded panel ── */}
      {activeTab && (
        <div className="max-h-32 overflow-y-auto rounded-lg border border-border bg-background">
          {activeTab === "queue" &&
            queue.map((item, idx) =>
              editingId === item.id ? (
                <EditingItemRow key={item.id} item={item} onDone={handleEditDone} />
              ) : (
                <QueueItemRow key={item.id} item={item} isFirst={idx === 0} onEdit={setEditingId} />
              ),
            )}

          {activeTab === "changes" &&
            stats?.files?.map((file) => (
              <div
                key={file.path}
                className="group/file flex items-center gap-2 px-3 py-1 text-xs hover:bg-muted/50 transition-colors"
              >
                <FileIcon className="size-3 flex-shrink-0 text-muted-foreground" />
                <span className="flex items-center gap-1 flex-shrink-0 text-[11px]">
                  {file.additions > 0 && (
                    <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
                  )}
                  {file.deletions > 0 && <span className="text-destructive">-{file.deletions}</span>}
                </span>
                <span className="truncate text-muted-foreground" title={file.path}>
                  {file.path}
                </span>
                {workDir && (
                  <div className="hidden lg:block">
                    <div className="opacity-0 group-hover/file:opacity-100 transition-opacity duration-150 flex-shrink-0">
                      <OpenInButton path={getFilePath(file.path)} />
                    </div>
                  </div>
                )}
              </div>
            ))}
        </div>
      )}

      {/* ── Tab bar ── */}
      <div className="flex items-center gap-1.5 px-1">
        {hasQueue && (
          <button
            type="button"
            onClick={() => toggleTab("queue")}
            className={cn(
              "flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs font-medium transition-colors cursor-pointer border",
              activeTab === "queue"
                ? "bg-secondary text-foreground border-border shadow-sm"
                : "bg-transparent text-muted-foreground border-border/60 hover:text-foreground hover:border-border",
            )}
          >
            <ListOrderedIcon className="size-3" />
            <span>{queue.length} Queued</span>
            <ChevronDownIcon
              className={cn(
                "size-3 transition-transform duration-200",
                activeTab === "queue" && "rotate-180",
              )}
            />
          </button>
        )}

        {hasChanges && stats?.files && (
          <button
            type="button"
            onClick={() => toggleTab("changes")}
            className={cn(
              "group/changes flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs font-medium transition-colors cursor-pointer border",
              activeTab === "changes"
                ? "bg-secondary text-foreground border-border shadow-sm"
                : "bg-transparent text-muted-foreground border-border/60 hover:text-foreground hover:border-border",
            )}
          >
            <GitBranchIcon className="size-3" />
            <span className="flex items-center gap-1">
              <span className="text-emerald-600 dark:text-emerald-400">
                +{stats.totalAdditions}
              </span>
              <span className="text-destructive">
                -{stats.totalDeletions}
              </span>
            </span>
            <span>
              {stats.files.length} file{stats.files.length !== 1 ? "s" : ""}
            </span>
            {workDir && (
              <span className="hidden lg:inline-flex opacity-0 group-hover/changes:opacity-100 transition-opacity">
                <OpenInButton path={workDir} />
              </span>
            )}
            <ChevronDownIcon
              className={cn(
                "size-3 transition-transform duration-200",
                activeTab === "changes" && "rotate-180",
              )}
            />
          </button>
        )}
      </div>
    </div>
  );
});
