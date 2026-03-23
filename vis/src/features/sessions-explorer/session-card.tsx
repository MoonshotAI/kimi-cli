import { useEffect, useRef, useState } from "react";
import {
  type SessionInfo,
  type SessionSummary,
  deleteSession,
  getSessionDownloadUrl,
  getSessionSummary,
} from "@/lib/api";
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
import { AlertCircle, Bot, Clock, Download, RefreshCw, Trash2, Zap } from "lucide-react";

function formatRelativeTime(epochSec: number): string {
  if (!epochSec) return "";
  const diff = Date.now() / 1000 - epochSec;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(epochSec * 1000).toLocaleDateString();
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(sec: number): string {
  if (sec < 1) return `${(sec * 1000).toFixed(0)}ms`;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${(sec / 60).toFixed(1)}min`;
}

function formatTokens(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

function HighlightText({ text, query }: { text: string; query?: string }) {
  if (!query || !text) return <>{text}</>;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-300/40 rounded px-0.5">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

interface SessionCardProps {
  session: SessionInfo;
  onSelect: () => void;
  compact?: boolean;
  searchQuery?: string;
  onDeleted?: (sessionId: string) => void;
}

export function SessionCard({ session, onSelect, compact, searchQuery, onDeleted }: SessionCardProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const displayTitle =
    session.metadata?.title && session.metadata.title !== "Untitled Session"
      ? session.metadata.title
      : session.title || "Untitled Session";

  const sessionPath = `${session.work_dir_hash}/${session.session_id}`;
  const downloadUrl = getSessionDownloadUrl(sessionPath);

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(downloadUrl, "_blank", "noopener,noreferrer");
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = () => {
    setDeleting(true);
    deleteSession(sessionPath)
      .then(() => {
        setDeleteDialogOpen(false);
        onDeleted?.(session.session_id);
      })
      .catch((err) => alert(err instanceof Error ? err.message : "Delete failed"))
      .finally(() => setDeleting(false));
  };

  const deleteDialog = session.imported ? (
    <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
      <AlertDialogContent onClick={(e) => e.stopPropagation()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete imported session?</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete the imported session
            &quot;{displayTitle}&quot;. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleDeleteConfirm} disabled={deleting}>
            {deleting ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ) : null;

  if (compact) {
    return (
      <>
        <button
          onClick={onSelect}
          className="flex items-center gap-3 w-full border-b px-3 py-2 text-left hover:bg-accent/50 transition-colors"
        >
          <span className="font-mono text-[10px] text-muted-foreground w-16 shrink-0">
            {session.session_id.slice(0, 8)}
          </span>
          {session.imported && (
            <span className="rounded bg-orange-500/10 text-orange-600 dark:text-orange-400 px-1 py-0 text-[9px] border border-orange-500/20 shrink-0">
              imported
            </span>
          )}
          <span className="text-xs truncate flex-1"><HighlightText text={displayTitle} query={searchQuery} /></span>
          <LazyStats sessionId={sessionPath} hasWire={session.has_wire} inline />
          <span className="text-[10px] text-muted-foreground shrink-0 w-14 text-right">
            {formatBytes(session.total_size)}
          </span>
          <span className="text-[10px] text-muted-foreground shrink-0 w-16 text-right">
            {formatRelativeTime(session.last_updated)}
          </span>
          <span
            role="button"
            tabIndex={0}
            onClick={handleDownload}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleDownload(e as unknown as React.MouseEvent); }}
            className="rounded p-0.5 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors shrink-0"
            title="Download session files"
          >
            <Download size={11} />
          </span>
          {session.imported && (
            <span
              role="button"
              tabIndex={0}
              onClick={handleDeleteClick}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleDeleteClick(e as unknown as React.MouseEvent); }}
              className="rounded p-0.5 hover:bg-red-500/10 text-muted-foreground hover:text-red-500 transition-colors shrink-0"
              title="Delete imported session"
            >
              <Trash2 size={11} />
            </span>
          )}
        </button>
        {deleteDialog}
      </>
    );
  }

  return (
    <>
      <button
        onClick={onSelect}
        className="rounded-lg border bg-card p-3 text-left hover:bg-accent/50 hover:border-primary/30 transition-colors w-full"
      >
        {/* Row 1: ID + time + actions */}
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] text-muted-foreground">
              {session.session_id.slice(0, 8)}
            </span>
            {session.imported && (
              <span className="rounded bg-orange-500/10 text-orange-600 dark:text-orange-400 px-1 py-0 text-[9px] border border-orange-500/20">
                imported
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <span
              role="button"
              tabIndex={0}
              onClick={handleDownload}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleDownload(e as unknown as React.MouseEvent); }}
              className="rounded p-0.5 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title="Download session files"
            >
              <Download size={12} />
            </span>
            {session.imported && (
              <span
                role="button"
                tabIndex={0}
                onClick={handleDeleteClick}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleDeleteClick(e as unknown as React.MouseEvent); }}
                className="rounded p-0.5 hover:bg-red-500/10 text-muted-foreground hover:text-red-500 transition-colors"
                title="Delete imported session"
              >
                <Trash2 size={12} />
              </span>
            )}
            <span className="text-[10px] text-muted-foreground">
              {formatRelativeTime(session.last_updated)}
            </span>
          </div>
        </div>

        {/* Row 2: Title */}
        <div className="text-sm font-medium truncate mb-1.5" title={displayTitle}>
          <HighlightText text={displayTitle} query={searchQuery} />
        </div>

        {/* Row 3: Availability badges + file size */}
        <div className="flex items-center gap-1 mb-2">
          {session.has_wire && (
            <span className="rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 px-1.5 py-0 text-[10px] border border-blue-500/20">
              wire
            </span>
          )}
          {session.has_context && (
            <span className="rounded bg-green-500/10 text-green-600 dark:text-green-400 px-1.5 py-0 text-[10px] border border-green-500/20">
              context
            </span>
          )}
          {session.has_state && (
            <span className="rounded bg-purple-500/10 text-purple-600 dark:text-purple-400 px-1.5 py-0 text-[10px] border border-purple-500/20">
              state
            </span>
          )}
          {(session.subagent_count ?? 0) > 0 && (
            <span className="flex items-center gap-0.5 rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 px-1.5 py-0 text-[10px] border border-indigo-500/20">
              <Bot size={9} />
              {session.subagent_count}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground ml-auto">
            {formatBytes(session.total_size)}
          </span>
        </div>

        {/* Row 4+: Lazy-loaded stats */}
        <LazyStats sessionId={sessionPath} hasWire={session.has_wire} />
      </button>
      {deleteDialog}
    </>
  );
}

function LazyStats({
  sessionId,
  hasWire,
  inline,
}: {
  sessionId: string;
  hasWire: boolean;
  inline?: boolean;
}) {
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hasWire || !ref.current) return;

    const el = ref.current;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setLoading(true);
          getSessionSummary(sessionId)
            .then(setSummary)
            .catch((err) => { console.warn(`Failed to load summary for ${sessionId}:`, err); })
            .finally(() => setLoading(false));
          observer.disconnect();
        }
      },
      { threshold: 0.1 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [sessionId, hasWire]);

  if (!hasWire) {
    return (
      <div ref={ref} className="text-[10px] text-muted-foreground">
        No wire data
      </div>
    );
  }

  if (!summary) {
    return (
      <div ref={ref}>
        {loading ? (
          inline ? (
            <div className="flex items-center gap-2 shrink-0">
              <div className="h-3 w-32 rounded bg-muted animate-pulse" />
            </div>
          ) : (
            <div className="border-t border-dashed pt-2 mt-1 space-y-1">
              <div className="h-3 w-full rounded bg-muted animate-pulse" />
              <div className="h-3 w-2/3 rounded bg-muted animate-pulse" />
            </div>
          )
        ) : (
          <div className="h-4" />
        )}
      </div>
    );
  }

  if (inline) {
    return (
      <div
        ref={ref}
        className="flex items-center gap-2 text-[10px] text-muted-foreground shrink-0"
      >
        <span className="text-blue-600 dark:text-blue-400">{summary.turns}T</span>
        <span className="text-green-600 dark:text-green-400">{summary.steps}S</span>
        <span className="text-purple-600 dark:text-purple-400">{summary.tool_calls}TC</span>
        {summary.errors > 0 && (
          <span className="text-red-500 font-medium">{summary.errors}E</span>
        )}
        <span>{formatTokens(summary.input_tokens + summary.output_tokens)}</span>
        <span>{formatDuration(summary.duration_sec)}</span>
      </div>
    );
  }

  return (
    <div ref={ref} className="border-t border-dashed pt-2 mt-1">
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground flex-wrap">
        <span className="text-blue-600 dark:text-blue-400">
          {summary.turns} turn{summary.turns !== 1 ? "s" : ""}
        </span>
        <span className="opacity-30">·</span>
        <span className="text-green-600 dark:text-green-400">
          {summary.steps} step{summary.steps !== 1 ? "s" : ""}
        </span>
        <span className="opacity-30">·</span>
        <span className="text-purple-600 dark:text-purple-400">
          {summary.tool_calls} tool{summary.tool_calls !== 1 ? "s" : ""}
        </span>
        {summary.compactions > 0 && (
          <>
            <span className="opacity-30">·</span>
            <span className="text-orange-600 dark:text-orange-400 inline-flex items-center gap-0.5">
              <RefreshCw size={9} />
              {summary.compactions}
            </span>
          </>
        )}
      </div>
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mt-1">
        <span className="inline-flex items-center gap-0.5">
          <Clock size={9} />
          {formatDuration(summary.duration_sec)}
        </span>
        {(summary.input_tokens > 0 || summary.output_tokens > 0) && (
          <>
            <span className="opacity-30">·</span>
            <span className="inline-flex items-center gap-0.5">
              <Zap size={9} />
              {formatTokens(summary.input_tokens)} in / {formatTokens(summary.output_tokens)} out
            </span>
          </>
        )}
        {summary.errors > 0 && (
          <>
            <span className="opacity-30">·</span>
            <span className="text-red-500 font-medium inline-flex items-center gap-0.5">
              <AlertCircle size={9} />
              {summary.errors} error{summary.errors !== 1 ? "s" : ""}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
