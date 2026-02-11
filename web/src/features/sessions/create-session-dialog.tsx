import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FolderOpen, Home, Loader2 } from "lucide-react";

const HOME_DIR_REGEX = /^(\/Users\/[^/]+|\/home\/[^/]+)/;

type CreateSessionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (workDir: string, createDir?: boolean) => Promise<void>;
  fetchWorkDirs: () => Promise<string[]>;
  fetchStartupDir: () => Promise<string>;
};

/**
 * Format a path for display:
 * - Replace home directory with ~
 * - For long paths, show ~/.../<last-two-segments>
 */
function formatPathForDisplay(path: string, maxSegments = 3): string {
  const homeMatch = path.match(HOME_DIR_REGEX);
  let displayPath = path;

  if (homeMatch) {
    displayPath = `~${path.slice(homeMatch[1].length)}`;
  }

  const segments = displayPath.split("/").filter(Boolean);

  if (segments.length <= maxSegments) {
    return displayPath.startsWith("~")
      ? displayPath
      : `/${segments.join("/")}`;
  }

  const prefix = displayPath.startsWith("~") ? "~" : "";
  const lastSegments = segments.slice(-2).join("/");
  return `${prefix}/.../${lastSegments}`;
}

// Module-level cache for work dirs (stale-while-revalidate)
let cachedWorkDirs: string[] | null = null;

export function CreateSessionDialog({
  open,
  onOpenChange,
  onConfirm,
  fetchWorkDirs,
  fetchStartupDir,
}: CreateSessionDialogProps): ReactElement {
  const [workDirs, setWorkDirs] = useState<string[]>(
    () => cachedWorkDirs ?? [],
  );
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [showConfirmCreate, setShowConfirmCreate] = useState(false);
  const [pendingPath, setPendingPath] = useState("");
  const [startupDir, setStartupDir] = useState("");
  const isCreatingRef = useRef(false);
  const commandListRef = useRef<HTMLDivElement>(null);

  // Fetch startup dir and work dirs independently for progressive loading
  useEffect(() => {
    if (!open) {
      return;
    }

    // Initialize from cache if available, still refresh in background
    if (cachedWorkDirs) {
      setWorkDirs(cachedWorkDirs);
    } else {
      setIsLoading(true);
    }

    // Startup dir resolves fast — show it immediately
    fetchStartupDir()
      .then((startup) => {
        if (startup) {
          setStartupDir(startup);
        }
      })
      .catch(() => {});

    // Work dirs may take longer — update cache when done
    fetchWorkDirs()
      .then((dirs) => {
        cachedWorkDirs = dirs;
        setWorkDirs(dirs);
      })
      .catch((error) => {
        console.error("Failed to fetch directories:", error);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [open, fetchWorkDirs, fetchStartupDir]);

  // Reset component state when dialog closes (cache persists at module level)
  useEffect(() => {
    if (!open) {
      setInputValue("");
      setWorkDirs(cachedWorkDirs ?? []);
      setIsCreating(false);
      setShowConfirmCreate(false);
      setPendingPath("");
      setStartupDir("");
      isCreatingRef.current = false;
    }
  }, [open]);

  const handleSelect = useCallback(
    async (dir: string) => {
      if (isCreatingRef.current) return;
      isCreatingRef.current = true;
      setIsCreating(true);
      try {
        await onConfirm(dir);
        onOpenChange(false);
      } catch (err) {
        if (
          err instanceof Error &&
          "isDirectoryNotFound" in err &&
          (err as Error & { isDirectoryNotFound: boolean }).isDirectoryNotFound
        ) {
          setPendingPath(dir);
          setShowConfirmCreate(true);
        }
      } finally {
        setIsCreating(false);
        isCreatingRef.current = false;
      }
    },
    [onConfirm, onOpenChange],
  );

  const handleInputSubmit = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed || isCreatingRef.current) return;
    handleSelect(trimmed);
  }, [inputValue, handleSelect]);

  const handleConfirmCreateDir = useCallback(async () => {
    if (!pendingPath) {
      return;
    }

    setShowConfirmCreate(false);
    setIsCreating(true);
    isCreatingRef.current = true;
    try {
      await onConfirm(pendingPath, true);
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to create directory:", err);
    } finally {
      setIsCreating(false);
      isCreatingRef.current = false;
      setPendingPath("");
    }
  }, [pendingPath, onConfirm, onOpenChange]);

  const handleCancelCreateDir = useCallback(() => {
    setShowConfirmCreate(false);
    setPendingPath("");
  }, []);

  // Tab completion: fill input with first matching item's value
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "Tab" || !commandListRef.current) return;

      // Find the currently selected (highlighted) item
      const selectedItem = commandListRef.current.querySelector<HTMLElement>(
        "[cmdk-item][data-selected=true]",
      );
      if (!selectedItem) return;

      const value = selectedItem.getAttribute("data-value");
      if (!value || value.startsWith("__custom__")) return;

      e.preventDefault();
      setInputValue(value);
    },
    [],
  );

  // Check if the current input matches any existing work dir
  const trimmedInput = inputValue.trim();
  const inputMatchesExisting =
    trimmedInput !== "" &&
    workDirs.some(
      (dir) => dir === trimmedInput || dir === trimmedInput.replace(/\/$/, ""),
    );

  const showCustomPathOption = trimmedInput !== "" && !inputMatchesExisting;

  // Recent dirs = workDirs excluding startupDir
  const recentDirs = useMemo(
    () => (startupDir ? workDirs.filter((d) => d !== startupDir) : workDirs),
    [workDirs, startupDir],
  );

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Create New Session"
        description="Search directories or type a new path"
        showCloseButton={false}
      >
        <Command>
          <CommandInput
            placeholder="Search directories or type a path..."
            value={inputValue}
            onValueChange={setInputValue}
            onKeyDown={handleKeyDown}
          />
          <CommandList ref={commandListRef}>
            <CommandEmpty>
              {trimmedInput
                ? "No matching directories."
                : isLoading
                  ? "Loading directories..."
                  : "Type a path to start a new session."}
            </CommandEmpty>

            {showCustomPathOption && (
              <>
                <CommandGroup heading="Custom Path">
                  <CommandItem
                    className="group"
                    value={`__custom__${trimmedInput}`}
                    onSelect={handleInputSubmit}
                    disabled={isCreating}
                  >
                    {isCreating ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <FolderOpen />
                    )}
                    <span className="flex-1 truncate">{trimmedInput}</span>
                    <kbd className="pointer-events-none ml-auto hidden select-none rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground group-data-[selected=true]:inline-flex">
                      ↵
                    </kbd>
                  </CommandItem>
                </CommandGroup>
                {(startupDir || recentDirs.length > 0 || isLoading) && (
                  <CommandSeparator />
                )}
              </>
            )}

            {startupDir && (
              <>
                <CommandGroup heading="Current Directory">
                  <CommandItem
                    className="group"
                    value={startupDir}
                    onSelect={() => handleSelect(startupDir)}
                    disabled={isCreating}
                  >
                    <Home />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="truncate">
                          {formatPathForDisplay(startupDir, 3)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        {startupDir}
                      </TooltipContent>
                    </Tooltip>
                    <kbd className="pointer-events-none ml-auto hidden select-none rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground group-data-[selected=true]:inline-flex">
                      ↵
                    </kbd>
                  </CommandItem>
                </CommandGroup>
                {(recentDirs.length > 0 || isLoading) && <CommandSeparator />}
              </>
            )}

            {recentDirs.length > 0 && (
              <CommandGroup heading="Recent Directories">
                {recentDirs.map((dir) => (
                  <CommandItem
                    className="group"
                    key={dir}
                    value={dir}
                    onSelect={() => handleSelect(dir)}
                    disabled={isCreating}
                  >
                    <FolderOpen />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="truncate">
                          {formatPathForDisplay(dir, 3)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="right">{dir}</TooltipContent>
                    </Tooltip>
                    <kbd className="pointer-events-none ml-auto hidden select-none rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground group-data-[selected=true]:inline-flex">
                      ↵
                    </kbd>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {isLoading && (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            )}
          </CommandList>
        </Command>
      </CommandDialog>

      <AlertDialog open={showConfirmCreate} onOpenChange={setShowConfirmCreate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Directory Not Found</AlertDialogTitle>
            <AlertDialogDescription>
              The directory{" "}
              <code className="bg-muted px-1 py-0.5 rounded text-foreground break-all">
                {pendingPath}
              </code>{" "}
              does not exist. Would you like to create it?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancelCreateDir}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmCreateDir}>
              Create Directory
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
