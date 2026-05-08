import { type UIEvent, useEffect, useMemo, useRef, useState } from "react";
import { type SessionInfo, importSession, listSessions } from "@/lib/api";
import {
  ExplorerToolbar,
  type FilterMode,
  type SortMode,
  type ViewMode,
} from "./explorer-toolbar";
import { ProjectGroup } from "./project-group";
import { SessionCard } from "./session-card";

const PAGE_SIZE = 30;

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface SessionsExplorerProps {
  onSelectSession: (sessionId: string) => void;
}

interface ProjectGroupData {
  workDir: string;
  sessions: SessionInfo[];
}

export function SessionsExplorer({ onSelectSession }: SessionsExplorerProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("time");
  const [grouped, setGrouped] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("cards");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [importing, setImporting] = useState(false);
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset display count when filters change
  useEffect(() => {
    setDisplayCount(PAGE_SIZE);
  }, [search, sortMode, filterMode, grouped]);

  const refreshSessions = async () => {
    try {
      const updated = await listSessions(true);
      setSessions(updated);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    listSessions()
      .then(setSessions)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // Keyboard: / to focus search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "/") {
        e.preventDefault();
        const input = document.querySelector("[data-session-search]") as HTMLInputElement | null;
        input?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleImport = async (file: File) => {
    setImporting(true);
    try {
      await importSession(file);
      await refreshSessions();
    } catch (err) {
      console.error("Import failed:", err);
      alert(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const handleSessionDeleted = (deletedSessionId: string) => {
    // Optimistic removal from local state
    setSessions((prev) => prev.filter((s) => s.session_id !== deletedSessionId));
    // Then refresh from server to ensure consistency
    refreshSessions();
  };

  const filtered = useMemo(() => {
    let result = sessions;

    // Apply imported filter
    if (filterMode === "imported") {
      result = result.filter((s) => s.imported);
    }

    // Apply search filter (trim handles pasted IDs with whitespace)
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(
        (s) =>
          s.session_id.toLowerCase().includes(q) ||
          s.title.toLowerCase().includes(q) ||
          (s.work_dir && s.work_dir.toLowerCase().includes(q)),
      );
    }

    return result;
  }, [sessions, search, filterMode]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    if (sortMode === "time") {
      arr.sort((a, b) => b.last_updated - a.last_updated);
    } else if (sortMode === "turns") {
      arr.sort((a, b) => b.turns - a.turns);
    } else if (sortMode === "name") {
      arr.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    }
    return arr;
  }, [filtered, sortMode]);

  // Auto-expand when content doesn't fill the container (no scrollbar → onScroll never fires)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || displayCount >= sorted.length) return;
    if (el.scrollHeight <= el.clientHeight) {
      setDisplayCount((prev) => Math.min(prev + PAGE_SIZE, sorted.length));
    }
  }, [displayCount, sorted.length]);

  const groups = useMemo((): ProjectGroupData[] => {
    if (!grouped) return [];
    const map = new Map<string, SessionInfo[]>();
    for (const s of sorted) {
      const key = s.imported ? "Imported" : (s.work_dir ?? "Unknown");
      const list = map.get(key);
      if (list) {
        list.push(s);
      } else {
        map.set(key, [s]);
      }
    }
    return Array.from(map.entries()).map(([workDir, sessions]) => ({
      workDir,
      sessions,
    }));
  }, [sorted, grouped]);

  const uniqueProjects = useMemo(() => {
    const dirs = new Set<string>();
    for (const s of sessions) dirs.add(s.work_dir ?? "Unknown");
    return dirs.size;
  }, [sessions]);

  const totalSize = useMemo(
    () => sessions.reduce((sum, s) => sum + s.total_size, 0),
    [sessions],
  );

  // Infinite scroll handler — called via React onScroll prop
  const handleScroll = (e: UIEvent<HTMLDivElement>) => {
    // Guard: don't increment if we're already showing everything
    if (displayCount >= sorted.length) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
      setDisplayCount((prev) => Math.min(prev + PAGE_SIZE, sorted.length));
    }
  };

  // Paginated sessions for flat views
  const displayedSessions = useMemo(
    () => sorted.slice(0, displayCount),
    [sorted, displayCount],
  );

  // Paginated groups
  const displayedGroups = useMemo((): ProjectGroupData[] => {
    if (!grouped) return [];
    // Show groups but limit total sessions rendered
    let remaining = displayCount;
    const result: ProjectGroupData[] = [];
    for (const g of groups) {
      if (remaining <= 0) break;
      const sliced = g.sessions.slice(0, remaining);
      result.push({ workDir: g.workDir, sessions: sliced });
      remaining -= sliced.length;
    }
    return result;
  }, [groups, grouped, displayCount]);

  const hasMore = sorted.length > displayCount;

  if (loading) {
    return (
      <div className="flex h-full flex-col">
        {/* Skeleton toolbar */}
        <div className="border-b px-4 py-2">
          <div className="flex items-center gap-2">
            <div className="h-6 w-48 rounded bg-muted animate-pulse" />
            <div className="h-4 w-px bg-border" />
            <div className="h-6 w-20 rounded bg-muted animate-pulse" />
            <div className="h-6 w-16 rounded bg-muted animate-pulse" />
          </div>
        </div>
        {/* Skeleton cards */}
        <div className="flex-1 overflow-auto p-4">
          {/* Skeleton group header */}
          <div className="flex items-center gap-2 px-2 py-1.5 mb-2">
            <div className="h-4 w-4 rounded bg-muted animate-pulse" />
            <div className="h-4 w-32 rounded bg-muted animate-pulse" />
            <div className="h-3 w-16 rounded bg-muted animate-pulse" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 ml-6">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <SkeletonCard key={i} delay={i * 75} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ExplorerToolbar
        search={search}
        onSearchChange={setSearch}
        sortMode={sortMode}
        onSortChange={setSortMode}
        grouped={grouped}
        onToggleGrouped={() => setGrouped((v) => !v)}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        filterMode={filterMode}
        onFilterModeChange={setFilterMode}
        totalCount={sessions.length}
        filteredCount={filtered.length}
        onImport={handleImport}
        importing={importing}
      />

      <div ref={scrollRef} className="flex-1 overflow-auto p-4" onScroll={handleScroll}>
        {grouped ? (
          displayedGroups.map((g) => (
            <ProjectGroup
              key={g.workDir}
              workDir={g.workDir}
              sessions={g.sessions}
              onSelectSession={onSelectSession}
              compact={viewMode === "compact"}
              searchQuery={search}
              onSessionDeleted={handleSessionDeleted}
            />
          ))
        ) : viewMode === "compact" ? (
          <div>
            {displayedSessions.map((s) => (
              <SessionCard
                key={`${s.session_id}-${s.work_dir_hash}`}
                session={s}
                onSelect={() => onSelectSession(`${s.work_dir_hash}/${s.session_id}`)}
                compact
                searchQuery={search}
                onDeleted={handleSessionDeleted}
              />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {displayedSessions.map((s) => (
              <SessionCard
                key={`${s.session_id}-${s.work_dir_hash}`}
                session={s}
                onSelect={() => onSelectSession(`${s.work_dir_hash}/${s.session_id}`)}
                searchQuery={search}
                onDeleted={handleSessionDeleted}
              />
            ))}
          </div>
        )}

        {/* Infinite scroll indicator */}
        {hasMore && (
          <div className="flex justify-center py-4 text-xs text-muted-foreground">
            Loading more sessions... ({displayCount} / {sorted.length})
          </div>
        )}

        {filtered.length === 0 && search && (
          <div className="flex items-center justify-center text-muted-foreground text-sm py-12">
            No sessions matching &quot;{search}&quot;
          </div>
        )}

        {filtered.length === 0 && !search && filterMode === "imported" && (
          <div className="flex flex-col items-center justify-center text-muted-foreground text-sm py-12 gap-2">
            <span>No imported sessions</span>
            <span className="text-xs">Import a session ZIP to get started.</span>
          </div>
        )}

        {sessions.length === 0 && !search && filterMode === "all" && (
          <div className="flex flex-col items-center justify-center text-muted-foreground py-12 gap-2">
            <span className="text-lg">No sessions found</span>
            <span className="text-sm">
              Run <code className="font-mono bg-muted px-1.5 py-0.5 rounded">kimi</code> to create your first session, or import a session ZIP.
            </span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t px-4 py-1.5 text-[11px] text-muted-foreground flex items-center gap-2">
        <span>{sessions.length} sessions</span>
        <span className="opacity-30">·</span>
        <span>{uniqueProjects} project{uniqueProjects !== 1 ? "s" : ""}</span>
        {totalSize > 0 && (
          <>
            <span className="opacity-30">·</span>
            <span>{formatBytes(totalSize)} total</span>
          </>
        )}
      </div>
    </div>
  );
}

function SkeletonCard({ delay = 0 }: { delay?: number }) {
  return (
    <div
      className="rounded-lg border bg-card p-3 space-y-2"
      style={{ animationDelay: `${delay}ms` }}
    >
      {/* ID + time */}
      <div className="flex items-center justify-between">
        <div className="h-3 w-14 rounded bg-muted animate-pulse" />
        <div className="h-3 w-12 rounded bg-muted animate-pulse" />
      </div>
      {/* Title */}
      <div className="h-4 w-3/4 rounded bg-muted animate-pulse" />
      {/* Badges */}
      <div className="flex items-center gap-1">
        <div className="h-4 w-10 rounded bg-muted animate-pulse" />
        <div className="h-4 w-14 rounded bg-muted animate-pulse" />
        <div className="h-4 w-10 rounded bg-muted animate-pulse" />
      </div>
      {/* Stats */}
      <div className="border-t border-dashed pt-2">
        <div className="h-3 w-full rounded bg-muted animate-pulse" />
        <div className="h-3 w-2/3 rounded bg-muted animate-pulse mt-1" />
      </div>
    </div>
  );
}
