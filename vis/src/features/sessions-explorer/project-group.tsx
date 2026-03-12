import { useState } from "react";
import { type SessionInfo } from "@/lib/api";
import { SessionCard } from "./session-card";
import { ChevronDown, ChevronRight, FolderOpen } from "lucide-react";

function shortProjectName(workDir: string): string {
  if (!workDir) return "Unknown";
  const parts = workDir.replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || workDir;
}

interface ProjectGroupProps {
  workDir: string;
  sessions: SessionInfo[];
  onSelectSession: (sessionId: string) => void;
  compact?: boolean;
  searchQuery?: string;
  onSessionDeleted?: (sessionId: string) => void;
}

export function ProjectGroup({
  workDir,
  sessions,
  onSelectSession,
  compact,
  searchQuery,
  onSessionDeleted,
}: ProjectGroupProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="mb-4">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-muted transition-colors"
      >
        {collapsed ? (
          <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
        )}
        <FolderOpen size={14} className="shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium truncate">
          {shortProjectName(workDir)}
        </span>
        <span className="text-[11px] text-muted-foreground shrink-0">
          ({sessions.length})
        </span>
        <span className="text-[10px] font-mono text-muted-foreground ml-auto truncate max-w-[300px] hidden md:block">
          {workDir}
        </span>
      </button>

      {!collapsed && (
        <div
          className={
            compact
              ? "mt-1 ml-6"
              : "mt-2 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 ml-6"
          }
        >
          {sessions.map((s) => (
            <SessionCard
              key={`${s.session_id}-${s.work_dir_hash}`}
              session={s}
              onSelect={() => onSelectSession(`${s.work_dir_hash}/${s.session_id}`)}
              compact={compact}
              searchQuery={searchQuery}
              onDeleted={onSessionDeleted}
            />
          ))}
        </div>
      )}
    </div>
  );
}
