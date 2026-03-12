import { type WireEvent } from "@/lib/api";
import { ShieldCheck, ShieldAlert, AlertCircle } from "lucide-react";

// ---------- Data structures ----------

export interface OrphanedEvent {
  event: WireEvent;
  reason: string;
}

export interface IntegrityResult {
  score: number; // 0-100
  totalPairable: number;
  orphans: OrphanedEvent[];
}

// ---------- Pure detection logic ----------

export function computeIntegrity(events: WireEvent[]): IntegrityResult {
  const orphans: OrphanedEvent[] = [];
  let totalPairable = 0;

  // --- TurnBegin / TurnEnd counter ---
  let turnCounter = 0;
  const turnBeginStack: WireEvent[] = [];
  for (const ev of events) {
    if (ev.type === "TurnBegin") {
      totalPairable++;
      turnCounter++;
      turnBeginStack.push(ev);
    } else if (ev.type === "TurnEnd") {
      totalPairable++;
      turnCounter--;
      if (turnCounter < 0) {
        orphans.push({ event: ev, reason: "TurnEnd without matching TurnBegin" });
        turnCounter = 0;
      } else {
        turnBeginStack.pop();
      }
    }
  }
  // Remaining unpaired TurnBegins
  for (const ev of turnBeginStack) {
    orphans.push({ event: ev, reason: "TurnBegin without matching TurnEnd" });
  }

  // --- CompactionBegin / CompactionEnd counter ---
  let compactionCounter = 0;
  const compactionBeginStack: WireEvent[] = [];
  for (const ev of events) {
    if (ev.type === "CompactionBegin") {
      totalPairable++;
      compactionCounter++;
      compactionBeginStack.push(ev);
    } else if (ev.type === "CompactionEnd") {
      totalPairable++;
      compactionCounter--;
      if (compactionCounter < 0) {
        orphans.push({ event: ev, reason: "CompactionEnd without matching CompactionBegin" });
        compactionCounter = 0;
      } else {
        compactionBeginStack.pop();
      }
    }
  }
  for (const ev of compactionBeginStack) {
    orphans.push({ event: ev, reason: "CompactionBegin without matching CompactionEnd" });
  }

  // --- ToolCall / ToolResult by id ---
  const toolCallMap = new Map<string, WireEvent>();
  for (const ev of events) {
    if (ev.type === "ToolCall") {
      totalPairable++;
      const fn = ev.payload.function as Record<string, unknown> | undefined;
      const id = (ev.payload.id ?? fn?.id ?? "") as string;
      if (id) {
        toolCallMap.set(id, ev);
      }
    } else if (ev.type === "ToolResult") {
      totalPairable++;
      const callId = ev.payload.tool_call_id as string | undefined;
      if (callId && toolCallMap.has(callId)) {
        toolCallMap.delete(callId);
      } else {
        orphans.push({ event: ev, reason: `ToolResult references unknown tool_call_id: ${callId ?? "(none)"}` });
      }
    }
  }
  for (const ev of toolCallMap.values()) {
    orphans.push({ event: ev, reason: "ToolCall without matching ToolResult" });
  }

  // --- ApprovalRequest / ApprovalResponse by id ---
  const approvalMap = new Map<string, WireEvent>();
  for (const ev of events) {
    if (ev.type === "ApprovalRequest") {
      totalPairable++;
      const id = ev.payload.id as string | undefined;
      if (id) {
        approvalMap.set(id, ev);
      }
    } else if (ev.type === "ApprovalResponse") {
      totalPairable++;
      const id = ev.payload.request_id as string | undefined;
      if (id && approvalMap.has(id)) {
        approvalMap.delete(id);
      } else {
        orphans.push({ event: ev, reason: `ApprovalResponse references unknown request id: ${id ?? "(none)"}` });
      }
    }
  }
  for (const ev of approvalMap.values()) {
    orphans.push({ event: ev, reason: "ApprovalRequest without matching ApprovalResponse" });
  }

  // --- Score ---
  const score = Math.round(
    (1 - orphans.length / Math.max(totalPairable, 1)) * 100,
  );

  return { score, totalPairable, orphans };
}

// ---------- UI component ----------

const TYPE_BADGE_COLORS: Record<string, string> = {
  TurnBegin: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
  TurnEnd: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
  CompactionBegin: "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30",
  CompactionEnd: "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30",
  ToolCall: "bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30",
  ToolResult: "bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30",
  ApprovalRequest: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  ApprovalResponse: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
};

function getTypeBadgeColor(type: string): string {
  return TYPE_BADGE_COLORS[type] ?? "bg-secondary text-secondary-foreground border-border";
}

interface IntegrityPanelProps {
  result: IntegrityResult;
  onScrollToIndex: (idx: number) => void;
}

export function IntegrityPanel({ result, onScrollToIndex }: IntegrityPanelProps) {
  const { score, totalPairable, orphans } = result;

  const ScoreIcon = score === 100 ? ShieldCheck : ShieldAlert;
  const scoreColor =
    score === 100
      ? "text-green-600 dark:text-green-400"
      : score >= 80
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-600 dark:text-red-400";

  return (
    <div className="border rounded-md bg-card p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <ScoreIcon size={16} className={scoreColor} />
        <span className={`text-sm font-semibold ${scoreColor}`}>
          {score}%
        </span>
        <span className="text-xs text-muted-foreground">
          integrity &middot; {totalPairable} pairable events &middot; {orphans.length} orphan{orphans.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Orphan list */}
      {orphans.length > 0 && (
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {orphans.map((o, i) => (
            <button
              key={i}
              onClick={() => onScrollToIndex(o.event.index)}
              className="flex items-center gap-2 w-full text-left rounded px-2 py-1 hover:bg-muted/60 transition-colors group"
            >
              {/* Type badge */}
              <span
                className={`shrink-0 rounded border px-1.5 py-0 text-[10px] font-medium ${getTypeBadgeColor(o.event.type)}`}
              >
                {o.event.type}
              </span>

              {/* Reason */}
              <span className="truncate text-[11px] text-muted-foreground group-hover:text-foreground">
                {o.reason}
              </span>

              {/* Event index */}
              <span className="ml-auto shrink-0 text-[10px] font-mono text-muted-foreground">
                #{o.event.index}
              </span>
            </button>
          ))}
        </div>
      )}

      {orphans.length === 0 && (
        <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
          <ShieldCheck size={13} />
          All pairable events are properly matched.
        </div>
      )}
    </div>
  );
}
