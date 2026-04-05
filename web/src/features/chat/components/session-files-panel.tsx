import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  FileTextIcon,
  FolderIcon,
  Loader2Icon,
  PanelRightCloseIcon,
  RefreshCwIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { SessionFileEntry } from "@/hooks/useSessions";
import { cn } from "@/lib/utils";

type SessionFilesPanelProps = {
  className?: string;
  sessionId: string;
  workDir?: string | null;
  onClose: () => void;
  onListSessionDirectory?: (
    sessionId: string,
    path?: string,
  ) => Promise<SessionFileEntry[]>;
  onGetSessionFileUrl?: (sessionId: string, path: string) => string;
};

const FILE_SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

function formatFileSize(size?: number): string | null {
  if (size === null || size === undefined) {
    return null;
  }
  if (size === 0) {
    return "0 B";
  }
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < FILE_SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)} ${FILE_SIZE_UNITS[unitIndex]}`;
}

function joinSessionPath(basePath: string, name: string): string {
  return basePath === "." ? name : `${basePath}/${name}`;
}

function getParentPath(path: string): string {
  if (path === ".") {
    return ".";
  }
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.length > 0 ? parts.join("/") : ".";
}

function getDisplayPath(path: string): string {
  return path === "." ? "." : `./${path}`;
}

export function SessionFilesPanel({
  className,
  sessionId,
  workDir,
  onClose,
  onListSessionDirectory,
  onGetSessionFileUrl,
}: SessionFilesPanelProps) {
  const [currentPath, setCurrentPath] = useState(".");
  const [entries, setEntries] = useState<SessionFileEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const loadDirectory = useCallback(
    async (path: string, refresh = false) => {
      if (!onListSessionDirectory) {
        return;
      }
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;

      if (refresh) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }
      setError(null);

      try {
        const nextEntries = await onListSessionDirectory(sessionId, path);
        if (requestId !== requestIdRef.current) {
          return;
        }
        setEntries(nextEntries);
      } catch (loadError) {
        if (requestId !== requestIdRef.current) {
          return;
        }
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load workspace files",
        );
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [onListSessionDirectory, sessionId],
  );

  useEffect(() => {
    loadDirectory(currentPath).catch(() => undefined);
  }, [currentPath, loadDirectory]);

  const handleRefresh = useCallback(() => {
    loadDirectory(currentPath, true).catch(() => undefined);
  }, [currentPath, loadDirectory]);

  const handleOpenDirectory = useCallback((path: string) => {
    setCurrentPath(path);
  }, []);

  const handleGoUp = useCallback(() => {
    setCurrentPath((path) => getParentPath(path));
  }, []);

  return (
    <aside
      className={cn(
        "flex h-full min-h-0 flex-col bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/85",
        className,
      )}
    >
      <div className="border-b px-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Workspace files</h2>
              <Badge variant="secondary">{entries.length}</Badge>
            </div>
            <p
              className="mt-1 truncate text-xs text-muted-foreground"
              title={workDir ?? undefined}
            >
              {workDir ?? "Current work directory"}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={handleRefresh}
              disabled={isLoading || isRefreshing}
              aria-label="Refresh workspace files"
            >
              <RefreshCwIcon
                className={cn(
                  "size-3.5",
                  (isLoading || isRefreshing) && "animate-spin",
                )}
              />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={onClose}
              aria-label="Close workspace files panel"
            >
              <PanelRightCloseIcon className="size-3.5" />
            </Button>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={handleGoUp}
            disabled={currentPath === "." || isLoading}
          >
            <ChevronLeftIcon className="size-3.5" />
            Up
          </Button>
          {currentPath !== "." ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setCurrentPath(".")}
              disabled={isLoading}
            >
              Root
            </Button>
          ) : null}
        </div>

        <div
          className="mt-2 truncate rounded-md border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground"
          title={getDisplayPath(currentPath)}
        >
          {getDisplayPath(currentPath)}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-3">
          {isLoading && entries.length === 0 ? (
            <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2Icon className="size-5 animate-spin" />
              <span>Loading files...</span>
            </div>
          ) : null}

          {!isLoading && error ? (
            <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-sm">
              <div className="flex items-start gap-2">
                <AlertTriangleIcon className="mt-0.5 size-4 text-destructive" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-foreground">
                    Failed to load this directory
                  </div>
                  <p className="mt-1 break-words text-muted-foreground">
                    {error}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="mt-3"
                    onClick={handleRefresh}
                  >
                    Try again
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {!(isLoading || error) && entries.length === 0 ? (
            <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-sm text-muted-foreground">
              <FolderIcon className="size-5" />
              <span>No files in this directory.</span>
            </div>
          ) : null}

          {!error
            ? entries.map((entry) => {
                const itemPath = joinSessionPath(currentPath, entry.name);
                const sizeLabel = formatFileSize(entry.size);
                const isDirectory = entry.type === "directory";

                return (
                  <div
                    key={`${entry.type}:${itemPath}`}
                    className="flex items-center gap-2 rounded-xl border bg-card/60 px-2.5 py-2"
                  >
                    {isDirectory ? (
                      <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                    )}

                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate text-sm font-medium"
                        title={entry.name}
                      >
                        {entry.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {isDirectory ? "Directory" : sizeLabel ?? "File"}
                      </div>
                    </div>

                    {isDirectory ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => handleOpenDirectory(itemPath)}
                        aria-label={`Open directory ${entry.name}`}
                      >
                        <ChevronRightIcon className="size-3.5" />
                      </Button>
                    ) : onGetSessionFileUrl ? (
                      <Button asChild variant="ghost" size="icon-xs">
                        <a
                          href={onGetSessionFileUrl(sessionId, itemPath)}
                          download={entry.name}
                          aria-label={`Download ${entry.name}`}
                        >
                          <DownloadIcon className="size-3.5" />
                        </a>
                      </Button>
                    ) : null}
                  </div>
                );
              })
            : null}
        </div>
      </ScrollArea>
    </aside>
  );
}
