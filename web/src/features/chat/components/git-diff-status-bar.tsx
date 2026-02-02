import { memo, useState, useCallback, useMemo } from "react";
import type { GitDiffStats } from "@/lib/api/models";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { isMacOS } from "@/hooks/utils";
import { toast } from "sonner";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  GitBranchIcon,
  FileIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  CodeIcon,
  AppWindowIcon,
  CopyIcon,
} from "lucide-react";

const TRAILING_SLASHES_REGEX = /\/+$/;

type GitDiffStatusBarProps = {
  stats: GitDiffStats | null;
  isLoading?: boolean;
  className?: string;
  workDir?: string | null;
};

type OpenTarget = {
  id: string;
  label: string;
  icon: React.ReactNode;
  backendApp: "finder" | "cursor" | "vscode";
};

const OPEN_TARGETS: OpenTarget[] = [
  {
    id: "finder",
    label: "Finder",
    icon: <FolderOpenIcon className="size-3.5" />,
    backendApp: "finder",
  },
  {
    id: "cursor",
    label: "Cursor",
    icon: <AppWindowIcon className="size-3.5" />,
    backendApp: "cursor",
  },
  {
    id: "vscode",
    label: "VS Code",
    icon: <CodeIcon className="size-3.5" />,
    backendApp: "vscode",
  },
];

async function openViaBackend(app: OpenTarget["backendApp"], path: string) {
  const response = await fetch("/api/open-in", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app, path }),
  });

  if (!response.ok) {
    let detail = "Failed to open application.";
    try {
      const data = await response.json();
      if (data?.detail) {
        detail = String(data.detail);
      }
    } catch {
      // ignore parse error
    }
    throw new Error(detail);
  }
}

type OpenInButtonProps = {
  path: string;
  className?: string;
};

function OpenInButton({ path, className }: OpenInButtonProps) {
  const isMac = isMacOS();

  const targets = useMemo(
    () => (isMac ? OPEN_TARGETS : OPEN_TARGETS.filter((t) => t.id !== "finder")),
    [isMac]
  );

  const handleOpen = useCallback(
    async (target: OpenTarget, e: Event) => {
      e.stopPropagation();
      try {
        await openViaBackend(target.backendApp, path);
      } catch (error) {
        toast.error("Failed to open", {
          description: error instanceof Error ? error.message : "Unexpected error",
        });
      }
    },
    [path]
  );

  const handleCopyPath = useCallback(
    async (e: Event) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(path);
        toast.success("Path copied", { description: path });
      } catch (error) {
        console.error("Failed to copy path:", error);
        toast.error("Failed to copy path");
      }
    },
    [path]
  );

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
            "border border-border/50 shadow-sm",
            "transition-all duration-150",
            "cursor-pointer",
            className
          )}
        >
          <ExternalLinkIcon className="size-2.5" />
          <span>Open</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[120px]" onClick={(e) => e.stopPropagation()}>
        {targets.map((target) => (
          <DropdownMenuItem
            key={target.id}
            onSelect={(e) => handleOpen(target, e)}
            className="text-xs"
          >
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

export const GitDiffStatusBar = memo(function GitDiffStatusBarComponent({
  stats,
  isLoading,
  className,
  workDir,
}: GitDiffStatusBarProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Don't render if not a git repo, no changes, or loading
  if (!((stats?.isGitRepo) && stats.hasChanges) || stats.error) {
    return null;
  }

  const { files, totalAdditions, totalDeletions } = stats;

  // Build full path for a file
  const getFilePath = (relativePath: string) => {
    if (!workDir) return relativePath;
    return `${workDir.replace(TRAILING_SLASHES_REGEX, "")}/${relativePath}`;
  };

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className={cn(
        "w-full border border-b-0 border-border rounded-t-xl bg-muted/30",
        isLoading && "opacity-70",
        className
      )}
    >
      <CollapsibleTrigger asChild>
        <div className="group/header flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 transition-colors">
          <GitBranchIcon className="size-3.5 flex-shrink-0" />
          <span className="flex items-center gap-1 flex-shrink-0">
            <span className="text-emerald-600 dark:text-emerald-400">
              +{totalAdditions}
            </span>
            <span className="text-destructive">-{totalDeletions}</span>
          </span>
          <span>
            {files.length} file{files.length !== 1 ? "s" : ""} changed
          </span>
          {/* Open project button - visible on hover */}
          {workDir && (
            <div className="hidden lg:block">
              <div className="hover-reveal opacity-0 group-hover/header:opacity-100 transition-opacity duration-150">
                <OpenInButton path={workDir} />
              </div>
            </div>
          )}
          <div className="flex-1" />
          {isOpen ? (
            <ChevronDownIcon className="size-3.5 flex-shrink-0" />
          ) : (
            <ChevronRightIcon className="size-3.5 flex-shrink-0" />
          )}
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="max-h-32 overflow-y-auto">
          {files.map((file) => (
            <div
              key={file.path}
              className="group/file flex items-center gap-2 px-3 py-1 text-xs hover:bg-muted/50 transition-colors"
            >
              <FileIcon className="size-3 flex-shrink-0 text-muted-foreground" />
              <span className="flex items-center gap-1 flex-shrink-0 text-[11px]">
                {file.additions > 0 && (
                  <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
                )}
                {file.deletions > 0 && (
                  <span className="text-destructive">-{file.deletions}</span>
                )}
              </span>
              <span className="truncate text-muted-foreground" title={file.path}>
                {file.path}
              </span>
              {/* Open file button - visible on hover */}
              {workDir && (
                <div className="hidden lg:block">
                  <div className="hover-reveal opacity-0 group-hover/file:opacity-100 transition-opacity duration-150 flex-shrink-0">
                    <OpenInButton path={getFilePath(file.path)} />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});
