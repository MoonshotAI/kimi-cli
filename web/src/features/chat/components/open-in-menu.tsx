import { useCallback, useMemo, type ReactNode } from "react";
import {
  ChevronDownIcon,
  CopyIcon,
  FolderOpenIcon,
  CodeIcon,
  SquareTerminalIcon,
  TerminalIcon,
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
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { isMacOS } from "@/hooks/utils";
import { getAuthHeader } from "@/lib/auth";
import { cn } from "@/lib/utils";

type OpenInMenuProps = {
  workDir?: string | null;
  className?: string;
};

type OpenTarget = {
  id: string;
  label: string;
  icon: ReactNode;
  backendApp: "finder" | "cursor" | "vscode" | "iterm" | "terminal";
  macOnly?: boolean;
  shortcut?: string;
};

const TRAILING_SLASH_REGEX = /\/+$/;

function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  if (trimmed === "") {
    return "/";
  }
  const cleaned = trimmed.replace(TRAILING_SLASH_REGEX, "");
  return cleaned === "" ? "/" : cleaned;
}

function compactPath(path: string, maxLength = 22): string {
  const normalized = normalizePath(path);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) {
    return normalized.slice(0, maxLength - 1) + "…";
  }
  const tail = parts.slice(-2).join("/");
  if (tail.length + 2 <= maxLength) {
    return `…/${tail}`;
  }
  return `…/${tail.slice(-maxLength + 2)}`;
}

async function openViaBackend(app: OpenTarget["backendApp"], path: string) {
  const response = await fetch("/api/open-in", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeader() },
    body: JSON.stringify({ app, path }),
  });

  if (response.ok) {
    return;
  }

  let detail = "Failed to open application.";
  try {
    const data = await response.json();
    if (data?.detail) {
      detail = String(data.detail);
    }
  } catch (error) {
    console.error("Failed to parse open-in error:", error);
  }
  throw new Error(detail);
}

export function OpenInMenu({ workDir, className }: OpenInMenuProps) {
  const isMac = isMacOS();
  const hasWorkDir = Boolean(workDir && workDir.trim().length > 0);
  const displayPath = workDir ? compactPath(workDir) : "No directory";

  const openTargets = useMemo<OpenTarget[]>(
    () => [
      {
        id: "finder",
        label: "Finder",
        icon: <FolderOpenIcon className="size-4" />,
        backendApp: "finder",
        macOnly: true,
      },
      {
        id: "cursor",
        label: "Cursor",
        icon: <AppWindowIcon className="size-4" />,
        backendApp: "cursor",
      },
      {
        id: "vscode",
        label: "VS Code",
        icon: <CodeIcon className="size-4" />,
        backendApp: "vscode",
      },
      {
        id: "iterm",
        label: "iTerm",
        icon: <TerminalIcon className="size-4" />,
        backendApp: "iterm",
        macOnly: true,
      },
      {
        id: "terminal",
        label: "Terminal",
        icon: <SquareTerminalIcon className="size-4" />,
        backendApp: "terminal",
        macOnly: true,
      },
    ],
    [],
  );

  const menuTargets = useMemo(
    () => openTargets.filter((target) => !target.macOnly || isMac),
    [openTargets, isMac],
  );

  const handleCopyPath = useCallback(async () => {
    if (!workDir) {
      return;
    }
    try {
      await navigator.clipboard.writeText(workDir);
      toast.success("Path copied", { description: workDir });
    } catch (error) {
      console.error("Failed to copy path:", error);
      toast.error("Failed to copy path");
    }
  }, [workDir]);

  const handleOpenTarget = useCallback(
    async (target: OpenTarget) => {
      if (!workDir) {
        toast.message("No working directory", {
          description: "Create a session with a working directory first.",
        });
        return;
      }
      try {
        await openViaBackend(target.backendApp, workDir);
      } catch (error) {
        console.error("Failed to open external URL:", error);
        toast.error("Failed to open application", {
          description:
            error instanceof Error ? error.message : "Unexpected error",
        });
      }
    },
    [workDir],
  );

  if (!isMac) {
    return null;
  }

  return (
    <ButtonGroup
      className={cn("h-8 items-center", className)}
      aria-label="Open working directory"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <ButtonGroupText
            className={cn(
              "h-8 max-w-[220px] px-3 text-xs font-semibold",
              "bg-secondary/40 text-foreground",
              !hasWorkDir && "text-muted-foreground",
            )}
          >
            <TerminalIcon className="size-3.5" />
            <span className="truncate">{displayPath}</span>
          </ButtonGroupText>
        </TooltipTrigger>
        {workDir ? (
          <TooltipContent side="bottom" className="max-w-md break-all">
            {workDir}
          </TooltipContent>
        ) : null}
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!hasWorkDir}
            className="h-8 rounded-l-none px-2 text-xs"
            aria-label="Open working directory in app"
          >
            Open
            <ChevronDownIcon className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {menuTargets.map((target) => (
            <DropdownMenuItem
              key={target.id}
              onSelect={() => handleOpenTarget(target)}
            >
              {target.icon}
              <span>{target.label}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleCopyPath}>
            <CopyIcon className="size-4" />
            <span>Copy path</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}
