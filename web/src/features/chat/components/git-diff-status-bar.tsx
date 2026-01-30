import { memo, useState } from "react";
import type { GitDiffStats } from "@/lib/api/models";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  GitBranchIcon,
  FileIcon,
} from "lucide-react";

type GitDiffStatusBarProps = {
  stats: GitDiffStats | null;
  isLoading?: boolean;
  className?: string;
};

export const GitDiffStatusBar = memo(function GitDiffStatusBarComponent({
  stats,
  isLoading,
  className,
}: GitDiffStatusBarProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Don't render if not a git repo, no changes, or loading
  if (!stats || !stats.isGitRepo || !stats.hasChanges || stats.error) {
    return null;
  }

  const { files, totalAdditions, totalDeletions } = stats;

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className={cn(
        "w-full border border-b-0 border-border rounded-t-xl bg-muted/30 ",
        isLoading && "opacity-70",
        className
      )}
    >
      <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 transition-colors">
        <div className="flex items-center gap-2">
          <GitBranchIcon className="size-3.5" />
          <span>
            {files.length} file{files.length !== 1 ? "s" : ""} changed
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="text-emerald-600 dark:text-emerald-400">
              +{totalAdditions}
            </span>
            <span className="text-destructive">-{totalDeletions}</span>
          </span>
          {isOpen ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="max-h-32 overflow-y-auto">
          {files.map((file) => (
            <div
              key={file.path}
              className="flex items-center justify-between px-3 py-1 text-xs hover:bg-muted/30"
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <FileIcon className="size-3 flex-shrink-0 text-muted-foreground" />
                <span className="truncate text-muted-foreground" title={file.path}>
                  {file.path}
                </span>
              </div>
              <div className="flex items-center gap-2 ml-2 flex-shrink-0">
                {file.additions > 0 && (
                  <span className="text-emerald-600 dark:text-emerald-400">
                    +{file.additions}
                  </span>
                )}
                {file.deletions > 0 && (
                  <span className="text-destructive">-{file.deletions}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});
