import { useEffect, useMemo, useState } from "react";
import { type SessionInfo, listSessions } from "@/lib/api";
import {
  ExplorerToolbar,
  type SortMode,
  type ViewMode,
} from "./explorer-toolbar";
import { ProjectGroup } from "./project-group";
import { SessionCard } from "./session-card";

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

  const filtered = useMemo(() => {
    if (!search) return sessions;
    const q = search.toLowerCase();
    return sessions.filter(
      (s) =>
        s.session_id.toLowerCase().includes(q) ||
        s.title.toLowerCase().includes(q) ||
        (s.work_dir && s.work_dir.toLowerCase().includes(q)),
    );
  }, [sessions, search]);

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

  const groups = useMemo((): ProjectGroupData[] => {
    if (!grouped) return [];
    const map = new Map<string, SessionInfo[]>();
    for (const s of sorted) {
      const key = s.work_dir ?? "Unknown";
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

  if (sessions.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-muted-foreground gap-2">
        <span className="text-lg">No sessions found</span>
        <span className="text-sm">
          Run <code className="font-mono bg-muted px-1.5 py-0.5 rounded">kimi</code> to create your first session.
        </span>
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
        totalCount={sessions.length}
        filteredCount={filtered.length}
      />

      <div className="flex-1 overflow-auto p-4">
        {grouped ? (
          groups.map((g) => (
            <ProjectGroup
              key={g.workDir}
              workDir={g.workDir}
              sessions={g.sessions}
              onSelectSession={onSelectSession}
              compact={viewMode === "compact"}
              searchQuery={search}
            />
          ))
        ) : viewMode === "compact" ? (
          <div>
            {sorted.map((s) => (
              <SessionCard
                key={`${s.session_id}-${s.work_dir_hash}`}
                session={s}
                onSelect={() => onSelectSession(`${s.work_dir_hash}/${s.session_id}`)}
                compact
                searchQuery={search}
              />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {sorted.map((s) => (
              <SessionCard
                key={`${s.session_id}-${s.work_dir_hash}`}
                session={s}
                onSelect={() => onSelectSession(`${s.work_dir_hash}/${s.session_id}`)}
                searchQuery={search}
              />
            ))}
          </div>
        )}

        {filtered.length === 0 && search && (
          <div className="flex items-center justify-center text-muted-foreground text-sm py-12">
            No sessions matching &quot;{search}&quot;
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
