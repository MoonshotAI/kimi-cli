import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import {
  AlertCircleIcon,
  FileTextIcon,
  PaperclipIcon,
  RefreshCwIcon,
} from "lucide-react";
import type { MentionOption, MentionSections } from "./useFileMentions";

const formatFileSize = (size?: number): string | null => {
  if (size === null || size === undefined) {
    return null;
  }
  if (size === 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const precision = value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[idx]}`;
};

type FileMentionMenuProps = {
  open: boolean;
  query: string;
  sections: MentionSections;
  flatOptions: MentionOption[];
  activeIndex: number;
  onSelect: (option: MentionOption) => void;
  onHover: (index: number) => void;
  workspaceStatus: "idle" | "loading" | "ready" | "error";
  workspaceError: string | null;
  onRetryWorkspace: () => void;
  isWorkspaceAvailable: boolean;
};

const SectionLabel: Record<MentionOption["type"], string> = {
  attachment: "Pending uploads",
  workspace: "Workspace files",
};

const TypeBadge: Record<MentionOption["type"], string> = {
  attachment: "Upload",
  workspace: "Workspace",
};

const TypeIcon = {
  attachment: PaperclipIcon,
  workspace: FileTextIcon,
};

const renderSection = ({
  label,
  options,
  activeIndex,
  activeItemRef,
  onHover,
  onSelect,
}: {
  label: string;
  options: MentionOption[];
  activeIndex: number;
  activeItemRef: React.RefObject<HTMLButtonElement | null>;
  onHover: (index: number) => void;
  onSelect: (option: MentionOption) => void;
}) => {
  if (!options.length) {
    return null;
  }

  return (
    <div className="py-0.5 px-1">
      <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div>
        {options.map((option) => {
          const Icon = TypeIcon[option.type];
          const isActive = option.order === activeIndex;
          const sizeLabel = formatFileSize(option.meta?.size);
          return (
            <button
              key={option.id}
              ref={isActive ? activeItemRef : undefined}
              type="button"
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors",
                isActive
                  ? "bg-primary/10 text-foreground ring-1 ring-primary/30"
                  : "hover:bg-muted",
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(option);
              }}
              onMouseEnter={() => onHover(option.order)}
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{option.label}</span>
                {option.description && option.description !== option.label ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </span>
              <div className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                {sizeLabel ? <span>{sizeLabel}</span> : null}
                <span className="rounded border border-border/60 px-1 py-px font-medium uppercase">
                  {TypeBadge[option.type]}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export const FileMentionMenu = ({
  open,
  query,
  sections,
  flatOptions,
  activeIndex,
  onSelect,
  onHover,
  workspaceStatus,
  workspaceError,
  onRetryWorkspace,
  isWorkspaceAvailable,
}: FileMentionMenuProps) => {
  const activeItemRef = useRef<HTMLButtonElement>(null);

  // Scroll active item into view when activeIndex changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: keep activeIndex to scroll on selection
  useEffect(() => {
    if (open && activeItemRef.current) {
      activeItemRef.current.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }, [open, activeIndex]);

  if (!open) {
    return null;
  }

  const hasSections =
    sections.attachments.length > 0 || sections.workspace.length > 0;
  const showStatus = workspaceStatus !== "idle" || !isWorkspaceAvailable;

  return (
    <div className="absolute left-0 right-0 bottom-[calc(100%+0.75rem)] z-30">
      <div className="rounded-xl border border-border/80 bg-popover/95 p-2 shadow-xl backdrop-blur supports-backdrop-filter:bg-popover/80">
        <div className="max-h-96 overflow-y-auto [-webkit-overflow-scrolling:touch]">
          {hasSections ? (
            <>
              {renderSection({
                label: SectionLabel.attachment,
                options: sections.attachments,
                activeIndex,
                activeItemRef,
                onHover,
                onSelect,
              })}
              {renderSection({
                label: SectionLabel.workspace,
                options: sections.workspace,
                activeIndex,
                activeItemRef,
                onHover,
                onSelect,
              })}
            </>
          ) : (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {query
                ? `No files match “@${query}”.`
                : "No files available to mention yet."}
            </div>
          )}
        </div>
        {showStatus ? (
          <div className="mt-2 rounded-md border border-border/80 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {workspaceStatus === "loading" ? (
              <div className="flex items-center gap-2">
                <RefreshCwIcon className="size-3.5 animate-spin text-primary" />
                Indexing workspace files…
              </div>
            ) : workspaceStatus === "error" ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 text-destructive">
                  <AlertCircleIcon className="size-3.5" />
                  {workspaceError ?? "Workspace files unavailable."}
                </span>
                <button
                  type="button"
                  className="text-xs font-semibold text-primary underline underline-offset-2"
                  onClick={onRetryWorkspace}
                >
                  Retry
                </button>
              </div>
            ) : isWorkspaceAvailable ? (
              <div className="flex items-center justify-between text-xs">
                <span>
                  {flatOptions.length
                    ? `${flatOptions.length} file${
                        flatOptions.length === 1 ? "" : "s"
                      } ready to mention.`
                    : "Workspace files indexed."}
                </span>
              </div>
            ) : (
              <span>
                Select an active session to enable workspace file mentions.
              </span>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
};
