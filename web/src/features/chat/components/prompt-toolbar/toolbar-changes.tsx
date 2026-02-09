import { type ReactElement, memo, useCallback } from "react";
import {
  ChevronDownIcon,
  FileIcon,
  GitBranchIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { GitDiffStats } from "@/lib/api/models";
import { OpenInButton } from "./open-in-button";

const TRAILING_SLASHES_REGEX = /\/+$/;

// ─── Exported components ─────────────────────────────────────

type ToolbarChangesPanelProps = {
  stats: GitDiffStats;
  workDir?: string | null;
};

export const ToolbarChangesPanel = memo(function ToolbarChangesPanelComponent({
  stats,
  workDir,
}: ToolbarChangesPanelProps): ReactElement {
  const getFilePath = useCallback(
    (relativePath: string) => {
      if (!workDir) return relativePath;
      return `${workDir.replace(TRAILING_SLASHES_REGEX, "")}/${relativePath}`;
    },
    [workDir],
  );

  return (
    <>
      {stats.files?.map((file) => (
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
    </>
  );
});

type ToolbarChangesTabProps = {
  stats: GitDiffStats;
  workDir?: string | null;
  isActive: boolean;
  onToggle: () => void;
};

export const ToolbarChangesTab = memo(function ToolbarChangesTabComponent({
  stats,
  workDir,
  isActive,
  onToggle,
}: ToolbarChangesTabProps): ReactElement {
  const fileCount = stats.files?.length ?? 0;

  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "group/changes flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs font-medium transition-colors cursor-pointer border",
        isActive
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
        {fileCount} file{fileCount !== 1 ? "s" : ""}
      </span>
      {workDir && (
        <span className="hidden lg:inline-flex opacity-0 group-hover/changes:opacity-100 transition-opacity">
          <OpenInButton path={workDir} />
        </span>
      )}
      <ChevronDownIcon
        className={cn(
          "size-3 transition-transform duration-200",
          isActive && "rotate-180",
        )}
      />
    </button>
  );
});
