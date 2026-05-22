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
const SUGGESTION_DEBOUNCE_MS = 150;

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

function parsePathInput(input: string): { parentPath: string; filter: string } {
  const trimmed = input.trim();
  if (!trimmed || trimmed === ".") {
    return { parentPath: ".", filter: "" };
  }
  // Strip leading ./
  const normalized = trimmed.replace(/^\.\//, "");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) {
    return { parentPath: ".", filter: normalized };
  }
  return {
    parentPath: normalized.slice(0, lastSlash),
    filter: normalized.slice(lastSlash + 1),
  };
}

function buildDisplayPath(parentPath: string, name: string): string {
  if (parentPath === ".") {
    return `./${name}`;
  }
  return `./${parentPath}/${name}`;
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

  // Path input & autocomplete state
  const [inputValue, setInputValue] = useState(".");
  const [suggestions, setSuggestions] = useState<SessionFileEntry[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestRequestIdRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  // When focused on a complete directory path (e.g. "./projects/foo" without "/"),
  // this ref stores the resolved directory path so applySuggestion can build
  // the correct full path (e.g. "./projects/foo/bar").
  const suggestionBasePathRef = useRef<string | null>(null);

  // Sync input value when currentPath changes externally (click, Up, Root)
  useEffect(() => {
    setInputValue(getDisplayPath(currentPath));
  }, [currentPath]);

  // Clear pending suggestion debounce timer on unmount
  useEffect(() => {
    return () => {
      if (suggestTimerRef.current) {
        clearTimeout(suggestTimerRef.current);
      }
    };
  }, []);

  // Inject CSS override for Radix UI ScrollArea (build-safe: inlined to avoid
  // Vite/Tailwind CSS tree-shaking dropping the global rule).
  useEffect(() => {
    const id = "session-files-scrollarea-fix";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent =
      '[data-radix-scroll-area-viewport] > div { display: block !important; min-width: 0 !important; }';
    document.head.appendChild(style);
    return () => {
      document.getElementById(id)?.remove();
    };
  }, []);

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

  const fetchSuggestions = useCallback(
    async (input: string, isFocus = false) => {
      if (!onListSessionDirectory) {
        setSuggestions([]);
        return;
      }

      const requestId = ++suggestRequestIdRef.current;

      // Focus mode: if input looks like a complete directory path
      // (no trailing "/"), try listing it directly first.
      if (isFocus && !input.endsWith("/") && input !== "." && input !== "./") {
        const fullPath = input.replace(/^\.\//, "");
        if (fullPath) {
          try {
            const entries = await onListSessionDirectory(sessionId, fullPath);
            if (requestId !== suggestRequestIdRef.current) return;
            // Full path is a directory — show its contents.
            suggestionBasePathRef.current = fullPath;
            setSuggestions(entries.slice(0, 20));
            setActiveSuggestion(-1);
            return;
          } catch {
            if (requestId !== suggestRequestIdRef.current) return;
            // Not a directory, fall through to normal behavior.
          }
        }
      }

      if (requestId !== suggestRequestIdRef.current) return;
      suggestionBasePathRef.current = null;
      const { parentPath, filter } = parsePathInput(input);
      try {
        const allEntries = await onListSessionDirectory(sessionId, parentPath);
        if (requestId !== suggestRequestIdRef.current) return;
        const filtered = filter
          ? allEntries.filter((e) =>
              e.name.toLowerCase().startsWith(filter.toLowerCase()),
            )
          : allEntries;
        setSuggestions(filtered.slice(0, 20));
        setActiveSuggestion(-1);
      } catch {
        if (requestId !== suggestRequestIdRef.current) return;
        setSuggestions([]);
      }
    },
    [onListSessionDirectory, sessionId],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setInputValue(value);
      setShowSuggestions(true);
      suggestionBasePathRef.current = null;

      if (suggestTimerRef.current) {
        clearTimeout(suggestTimerRef.current);
      }
      suggestTimerRef.current = setTimeout(() => {
        fetchSuggestions(value).catch(() => undefined);
      }, SUGGESTION_DEBOUNCE_MS);
    },
    [fetchSuggestions],
  );

  const navigateToInputPath = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed || trimmed === ".") {
      setCurrentPath(".");
      setShowSuggestions(false);
      suggestionBasePathRef.current = null;
      return;
    }
    // Strip leading ./ and / if present
    let target = trimmed.replace(/^\.?\//, "");
    if (target === "") {
      target = ".";
    }
    setCurrentPath(target);
    setShowSuggestions(false);
    setActiveSuggestion(-1);
    suggestionBasePathRef.current = null;
  }, [inputValue]);

  const applySuggestion = useCallback(
    (suggestion: SessionFileEntry) => {
      const basePath = suggestionBasePathRef.current;
      let fullPath: string;
      let display: string;

      if (basePath) {
        // Focus-directory mode: basePath itself is the parent directory.
        fullPath = joinSessionPath(basePath, suggestion.name);
        display = buildDisplayPath(basePath, suggestion.name);
      } else {
        const { parentPath, filter } = parsePathInput(inputValue);
        fullPath = joinSessionPath(parentPath, suggestion.name);
        display = buildDisplayPath(parentPath, suggestion.name);
      }

      setShowSuggestions(false);
      setActiveSuggestion(-1);
      suggestionBasePathRef.current = null;

      if (suggestion.type === "directory") {
        setInputValue(display);
        setCurrentPath(fullPath);
      } else {
        // File selected: trigger download if possible, otherwise reset
        // the input to the current directory so we don't leave a file
        // path that would fail on next Enter.
        if (onGetSessionFileUrl) {
          const url = onGetSessionFileUrl(sessionId, fullPath);
          const a = document.createElement("a");
          a.href = url;
          a.download = suggestion.name;
          a.style.display = "none";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }
        setInputValue(getDisplayPath(currentPath));
        inputRef.current?.focus();
      }
    },
    [inputValue, currentPath, onGetSessionFileUrl, sessionId],
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (isComposingRef.current) {
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        if (showSuggestions && activeSuggestion >= 0 && suggestions[activeSuggestion]) {
          applySuggestion(suggestions[activeSuggestion]);
        } else {
          navigateToInputPath();
        }
        return;
      }

      if (e.key === "Escape") {
        setShowSuggestions(false);
        setActiveSuggestion(-1);
        return;
      }

      if (!showSuggestions || suggestions.length === 0) {
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveSuggestion((prev) =>
          prev < suggestions.length - 1 ? prev + 1 : 0,
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveSuggestion((prev) =>
          prev > 0 ? prev - 1 : suggestions.length - 1,
        );
      }
    },
    [
      showSuggestions,
      activeSuggestion,
      suggestions,
      applySuggestion,
      navigateToInputPath,
    ],
  );

  // Close suggestions on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

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

        {/* Editable path input with autocomplete */}
        <div ref={containerRef} className="relative mt-2">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
            onFocus={() => {
              setShowSuggestions(true);
              fetchSuggestions(inputValue, true).catch(() => undefined);
            }}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              isComposingRef.current = false;
              setInputValue(e.currentTarget.value);
              fetchSuggestions(e.currentTarget.value).catch(() => undefined);
            }}
            className={cn(
              "w-full truncate rounded-md border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground outline-none transition-[color,box-shadow]",
              "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[2px]",
              "aria-invalid:ring-destructive/20 aria-invalid:border-destructive",
            )}
            aria-label="Current path"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />

          {showSuggestions && suggestions.length > 0 && (
            <div className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-popover shadow-md">
              {suggestions.map((entry, index) => {
                const isDir = entry.type === "directory";
                return (
                  <button
                    key={`${entry.type}:${entry.name}`}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applySuggestion(entry)}
                    className={cn(
                      "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors",
                      index === activeSuggestion
                        ? "bg-accent text-accent-foreground"
                        : "text-popover-foreground hover:bg-accent/50",
                    )}
                  >
                    {isDir ? (
                      <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{entry.name}</span>
                    {isDir && (
                      <ChevronRightIcon className="ml-auto size-3 shrink-0 text-muted-foreground" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
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
                <div className="min-w-0 flex-1 overflow-hidden">
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

          {!isLoading && !error && entries.length === 0 ? (
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
                    className="flex items-center gap-2 rounded-xl border bg-card/60 px-2.5 py-2 overflow-hidden"
                    style={{ overflow: "hidden" }}
                  >
                    {isDirectory ? (
                      <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                    )}

                    <div
                      className="min-w-0 flex-1 overflow-hidden"
                      style={{ overflow: "hidden" }}
                    >
                      <div
                        className="truncate text-sm font-medium w-full"
                        style={{
                          width: "100%",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
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
