import { useEffect, useState } from "react";
import { getSessionState } from "@/lib/api";
import {
  ChevronDown,
  ChevronRight,
  Shield,
  Users,
  FolderOpen,
} from "lucide-react";

interface StateViewerProps {
  sessionId: string;
  refreshKey?: number;
}

function JsonValue({
  value,
  depth = 0,
}: {
  value: unknown;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(depth < 2);

  if (value === null) {
    return <span className="text-muted-foreground italic">null</span>;
  }

  if (typeof value === "boolean") {
    return (
      <span className={value ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}>
        {String(value)}
      </span>
    );
  }

  if (typeof value === "number") {
    return <span className="text-blue-600 dark:text-blue-400">{value}</span>;
  }

  if (typeof value === "string") {
    return (
      <span className="text-amber-700 dark:text-amber-300">
        &quot;{value}&quot;
      </span>
    );
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-muted-foreground">[]</span>;
    }
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="text-xs">[{value.length}]</span>
        </button>
        {expanded && (
          <div className="ml-4 border-l border-border pl-3">
            {value.map((item, i) => (
              <div key={i} className="py-0.5">
                <span className="text-muted-foreground text-[11px] mr-2">
                  {i}:
                </span>
                <JsonValue value={item} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return <span className="text-muted-foreground">{"{}"}</span>;
    }
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="text-xs">{`{${entries.length}}`}</span>
        </button>
        {expanded && (
          <div className="ml-4 border-l border-border pl-3">
            {entries.map(([key, val]) => (
              <div key={key} className="py-0.5">
                <span className="font-medium text-xs">{key}: </span>
                <JsonValue value={val} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return <span>{String(value)}</span>;
}

export function StateViewer({ sessionId, refreshKey = 0 }: StateViewerProps) {
  const [state, setState] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getSessionState(sessionId, refreshKey > 0)
      .then(setState)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [sessionId, refreshKey]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Loading state...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-destructive">
        Error: {error}
      </div>
    );
  }

  if (!state || Object.keys(state).length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        No state data found
      </div>
    );
  }

  const approval = state.approval as Record<string, unknown> | undefined;
  const subagents = state.dynamic_subagents as unknown[] | undefined;
  const additionalDirs = state.additional_dirs as string[] | undefined;

  return (
    <div className="h-full overflow-auto p-4 space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Approval */}
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <Shield size={16} className="text-muted-foreground" />
            <h3 className="text-sm font-semibold">Approval</h3>
          </div>
          {approval && (
            <div className="space-y-1.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">YOLO Mode</span>
                <span
                  className={`font-medium ${approval.yolo ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}
                >
                  {approval.yolo ? "ON" : "OFF"}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">
                  Auto-approved actions:
                </span>
                {Array.isArray(approval.auto_approve_actions) &&
                approval.auto_approve_actions.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(approval.auto_approve_actions as string[]).map((a) => (
                      <span
                        key={a}
                        className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-mono"
                      >
                        {a}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="ml-1 text-muted-foreground">none</span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Subagents */}
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <Users size={16} className="text-muted-foreground" />
            <h3 className="text-sm font-semibold">Dynamic Subagents</h3>
          </div>
          <div className="text-xs">
            {subagents && subagents.length > 0 ? (
              <div className="space-y-1">
                {subagents.map((sa, i) => {
                  const agent = sa as Record<string, unknown>;
                  return (
                    <div
                      key={i}
                      className="rounded bg-secondary px-2 py-1 font-mono"
                    >
                      {String(agent.name ?? "unnamed")}
                    </div>
                  );
                })}
              </div>
            ) : (
              <span className="text-muted-foreground">No subagents</span>
            )}
          </div>
        </div>

        {/* Additional Dirs */}
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <FolderOpen size={16} className="text-muted-foreground" />
            <h3 className="text-sm font-semibold">Additional Dirs</h3>
          </div>
          <div className="text-xs">
            {additionalDirs && additionalDirs.length > 0 ? (
              <div className="space-y-1">
                {additionalDirs.map((d) => (
                  <div key={d} className="truncate font-mono text-muted-foreground">
                    {d}
                  </div>
                ))}
              </div>
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </div>
        </div>
      </div>

      {/* Full JSON tree */}
      <div className="rounded-lg border bg-card p-4">
        <h3 className="text-sm font-semibold mb-3">Raw State</h3>
        <div className="font-mono text-xs">
          <JsonValue value={state} />
        </div>
      </div>
    </div>
  );
}
