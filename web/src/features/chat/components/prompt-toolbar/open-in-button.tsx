import { type ReactNode, useCallback, useMemo } from "react";
import {
  CopyIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  CodeIcon,
  AppWindowIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { isMacOS } from "@/hooks/utils";
import {
  type OpenTargetDef,
  ALL_OPEN_TARGETS,
  openViaBackend,
  setLastOpenTargetId,
} from "@/features/chat/open-in-shared";

type OpenTarget = OpenTargetDef & {
  icon: ReactNode;
};

/** IDs of targets shown in the lightweight file-level button. */
const BUTTON_TARGET_IDS = new Set(["finder", "cursor", "vscode"]);

const ICON_MAP: Record<string, ReactNode> = {
  finder: <FolderOpenIcon className="size-3.5" />,
  cursor: <AppWindowIcon className="size-3.5" />,
  vscode: <CodeIcon className="size-3.5" />,
};

export function OpenInButton({
  path,
  className,
}: {
  path: string;
  className?: string;
}) {
  const isMac = isMacOS();

  const targets = useMemo<OpenTarget[]>(
    () =>
      ALL_OPEN_TARGETS.filter(
        (t) => BUTTON_TARGET_IDS.has(t.id) && (!t.macOnly || isMac),
      ).map((t) => ({ ...t, icon: ICON_MAP[t.id] })),
    [isMac],
  );

  const handleOpen = useCallback(
    async (target: OpenTarget, e: Event) => {
      e.stopPropagation();
      try {
        await openViaBackend(target.backendApp, path);
        setLastOpenTargetId(target.id);
      } catch (error) {
        toast.error("Failed to open", {
          description:
            error instanceof Error ? error.message : "Unexpected error",
        });
      }
    },
    [path],
  );

  const handleCopyPath = useCallback(
    async (e: Event) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(path);
        toast.success("Path copied", { description: path });
      } catch {
        toast.error("Failed to copy path");
      }
    },
    [path],
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
            "border border-border/50 shadow-sm transition-all duration-150 cursor-pointer",
            className,
          )}
        >
          <ExternalLinkIcon className="size-2.5" />
          <span>Open</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[120px]"
        onClick={(e) => e.stopPropagation()}
      >
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
