import { type ReactElement, useCallback, useMemo } from "react";
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
import { getAuthHeader } from "@/lib/auth";
import { isMacOS } from "@/hooks/utils";

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

export function OpenInButton({ path, className }: { path: string; className?: string }) {
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
