import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactElement,
} from "react";
import { FolderOpen, Loader2, ChevronDown } from "lucide-react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
  // Detect home directory prefix (works for most Unix-like systems)
  const homeMatch = path.match(HOME_DIR_REGEX);
  let displayPath = path;

  if (homeMatch) {
    displayPath = "~" + path.slice(homeMatch[1].length);
  }

  const segments = displayPath.split("/").filter(Boolean);

  // If path is short enough, return as is
  if (segments.length <= maxSegments) {
    return displayPath.startsWith("~")
      ? displayPath
      : "/" + segments.join("/");
  }

  // For long paths, show first segment (~ or root) + ... + last two segments
  const prefix = displayPath.startsWith("~") ? "~" : "";
  const lastSegments = segments.slice(-2).join("/");
  return `${prefix}/.../${lastSegments}`;
}

export function CreateSessionDialog({
  open,
  onOpenChange,
  onConfirm,
  fetchWorkDirs,
  fetchStartupDir,
}: CreateSessionDialogProps): ReactElement {
  const [workDirs, setWorkDirs] = useState<string[]>([]);
  const [path, setPath] = useState<string>("");
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [showConfirmCreate, setShowConfirmCreate] = useState(false);
  const [pendingPath, setPendingPath] = useState<string>("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);


  // Fetch work directories and startup directory when dialog opens
  useEffect(() => {
    if (!open) {
      return;
    }

    setIsLoading(true);
    Promise.all([fetchWorkDirs(), fetchStartupDir()])
      .then(([dirs, startupDir]) => {
        setWorkDirs(dirs);
        // Set the startup directory as the default path
        if (startupDir) {
          setPath((current) => (current ? current : startupDir));
        }
      })
      .catch((error) => {
        console.error("Failed to fetch directories:", error);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [open, fetchWorkDirs, fetchStartupDir]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setPath("");
      setIsDropdownOpen(false);
      setIsCreating(false);
      setShowConfirmCreate(false);
      setPendingPath("");
    }
  }, [open]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!isDropdownOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsDropdownOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isDropdownOpen]);

  const handleSelectDir = useCallback((dir: string) => {
    setPath(dir);
    setIsDropdownOpen(false);
    inputRef.current?.focus();
  }, []);

  const handleConfirm = useCallback(async () => {
    const workDir = path.trim();
    if (!workDir) {
      return;
    }

    setIsCreating(true);
    try {
      await onConfirm(workDir);
      onOpenChange(false);
    } catch (err) {
      // Check if this is a directory not found error
      if (
        err instanceof Error &&
        "isDirectoryNotFound" in err &&
        (err as Error & { isDirectoryNotFound: boolean }).isDirectoryNotFound
      ) {
        // Show confirmation dialog
        setPendingPath(workDir);
        setShowConfirmCreate(true);
      }
      // Other errors are handled by the hook
    } finally {
      setIsCreating(false);
    }
  }, [path, onConfirm, onOpenChange]);

  const handleConfirmCreateDir = useCallback(async () => {
    if (!pendingPath) {
      return;
    }

    setShowConfirmCreate(false);
    setIsCreating(true);
    try {
      await onConfirm(pendingPath, true);
      onOpenChange(false);
    } catch (err) {
      // Other errors are handled by the hook
    } finally {
      setIsCreating(false);
      setPendingPath("");
    }
  }, [pendingPath, onConfirm, onOpenChange]);

  const handleCancelCreateDir = useCallback(() => {
    setShowConfirmCreate(false);
    setPendingPath("");
  }, []);

  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && path.trim() && !isCreating) {
        handleConfirm();
      } else if (e.key === "Escape") {
        setIsDropdownOpen(false);
      }
    },
    [path, isCreating, handleConfirm],
  );

  const isConfirmDisabled = isCreating || !path.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg w-[min(calc(100vw-2rem),32rem)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderOpen className="size-5" />
            Create New Session
          </DialogTitle>
          <DialogDescription>
            Input or select the working directory for this session.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <div ref={containerRef} className="relative">
            {/* Input with dropdown button */}
            <div className="flex items-center border border-input rounded-md focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 ">
              <Input
                ref={inputRef}
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Enter or select a folder..."
                className="border-0 focus-visible:ring-0 focus-visible:ring-offset-0 !bg-background "
                disabled={isLoading}
              />

              <div className="mx-0 h-4 w-px bg-border/70 mr-2" />

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-9 px-2 bg-background"
                    onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                    disabled={isLoading}
                  >
                    {isLoading ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ChevronDown
                        className={`size-4 transition-transform ${isDropdownOpen ? "rotate-180" : ""}`}
                      />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  History folders
                </TooltipContent>
              </Tooltip>
            </div>

            {/* Dropdown list */}
            {isDropdownOpen && !isLoading && (
              <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-lg max-h-64 overflow-y-auto [-webkit-overflow-scrolling:touch]">
                {workDirs.length > 0 ? (
                  workDirs.map((dir) => (
                    <button
                      key={dir}
                      type="button"
                      className="w-full px-3 py-2 text-left hover:bg-accent cursor-pointer transition-colors"
                      onClick={() => handleSelectDir(dir)}
                    >
                      <div className="text-sm font-medium truncate">
                        {formatPathForDisplay(dir, 3)}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {dir}
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="px-3 py-3 text-sm text-muted-foreground">
                    No history folders
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={isCreating}
          >
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={isConfirmDisabled}>
            {isCreating ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Creating...
              </>
            ) : (
              "Create"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Confirmation dialog for creating non-existent directory */}
      <AlertDialog open={showConfirmCreate} onOpenChange={setShowConfirmCreate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Directory Not Found</AlertDialogTitle>
            <AlertDialogDescription>
              The directory <code className="bg-muted px-1 py-0.5 rounded text-foreground break-all">{pendingPath}</code> does not exist. Would you like to create it?
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
    </Dialog>
  );
}
