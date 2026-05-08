import { useCallback, useMemo, useRef, useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  Layers,
  ArrowDownNarrowWide,
  ZoomIn,
  ZoomOut,
  Activity,
  Timer,
} from "lucide-react";
import type { WireEvent } from "@/lib/api";

// ─── Types ──────────────────────────────────────────────────────────────────

interface TimelineViewProps {
  events: WireEvent[];
  onScrollToIndex: (eventIndex: number) => void;
}

type BarColor = "blue" | "purple" | "amber" | "green" | "cyan" | "indigo" | "violet";

type TooltipPayload =
  | {
      kind: "turn";
      turnNumber: number;
      userInput: string;
      stepCount: number;
      toolCallCount: number;
    }
  | { kind: "step"; stepNumber: number; turnNumber: number; toolCallCount: number }
  | {
      kind: "tool";
      toolName: string;
      toolCallId: string;
      hasError: boolean;
      argsSummary: string;
    }
  | { kind: "thinking"; isThinking: boolean; charCount: number }
  | {
      kind: "approval";
      sender: string;
      action: string;
      response: string;
    }
  | { kind: "subagent"; taskToolCallId: string; eventCount: number; subagentType?: string; agentId?: string };

interface TimelineBar {
  label: string;
  eventIndex: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  depth: number;
  color: BarColor;
  hasError?: boolean;
  dashed?: boolean;
  striped?: boolean;
  tooltipData?: TooltipPayload;
}

interface CompactionMarker {
  startSec: number;
  endSec: number;
  eventIndex: number;
}

interface GapIndicator {
  startSec: number;
  endSec: number;
  durationSec: number;
  depth: number;
}

interface TokenDataPoint {
  timeSec: number;
  inputTokens: number;
  outputTokens: number;
  contextUsage: number;
  eventIndex: number;
}

interface BuildTimelineResult {
  bars: TimelineBar[];
  totalSec: number;
  compactionMarkers: CompactionMarker[];
  tokenData: TokenDataPoint[];
  gaps: GapIndicator[];
}

type SortMode = "hierarchy" | "chronological";

// ─── Build Timeline ─────────────────────────────────────────────────────────

function buildTimeline(events: WireEvent[]): BuildTimelineResult {
  if (events.length === 0)
    return { bars: [], totalSec: 0, compactionMarkers: [], tokenData: [], gaps: [] };

  const bars: TimelineBar[] = [];
  const compactionMarkers: CompactionMarker[] = [];
  const tokenData: TokenDataPoint[] = [];
  const t0 = events[0].timestamp;

  // ── Track turns and steps ──
  let currentTurnStart: number | null = null;
  let currentTurnIndex = 0;
  let turnNumber = 0;
  let currentStepStart: number | null = null;
  let currentStepIndex = 0;
  let stepNumber = 0;

  // Counters for tooltip enrichment
  let turnStepCount = 0;
  let turnToolCallCount = 0;
  let stepToolCallCount = 0;
  let turnUserInput = "";

  // ── Track tool calls ──
  const openToolCalls = new Map<
    string,
    { name: string; startTime: number; eventIndex: number; argsSummary: string }
  >();

  // ── Track approvals ──
  const openApprovals = new Map<
    string,
    { startTime: number; eventIndex: number; sender: string; action: string }
  >();

  // ── Track compaction ──
  let compactionStart: number | null = null;
  let compactionIndex = 0;

  // ── Track generation/thinking ──
  let genStart: number | null = null;
  let genIndex = 0;
  let genCharCount = 0;
  let genIsThinking = false;

  // ── Track sub-agents ──
  const subagentData = new Map<string, { startTime: number; endTime: number; eventIndex: number; eventCount: number; subagentType?: string; agentId?: string }>();

  const closeGeneration = (t: number) => {
    if (genStart !== null) {
      const dur = t - genStart;
      if (dur > 0.001) {
        bars.push({
          label: genIsThinking ? "Thinking" : "Generation",
          eventIndex: genIndex,
          startSec: genStart,
          endSec: t,
          durationSec: dur,
          depth: 2,
          color: "cyan",
          dashed: true,
          tooltipData: {
            kind: "thinking",
            isThinking: genIsThinking,
            charCount: genCharCount,
          },
        });
      }
      genStart = null;
      genCharCount = 0;
    }
  };

  const closeTurn = (t: number) => {
    if (currentTurnStart != null) {
      bars.push({
        label: `Turn ${turnNumber}`,
        eventIndex: currentTurnIndex,
        startSec: currentTurnStart,
        endSec: t,
        durationSec: t - currentTurnStart,
        depth: 0,
        color: "blue",
        tooltipData: {
          kind: "turn",
          turnNumber,
          userInput: turnUserInput,
          stepCount: turnStepCount,
          toolCallCount: turnToolCallCount,
        },
      });
      currentTurnStart = null;
    }
  };

  const closeStep = (t: number) => {
    if (currentStepStart != null) {
      bars.push({
        label: `Step ${stepNumber}`,
        eventIndex: currentStepIndex,
        startSec: currentStepStart,
        endSec: t,
        durationSec: t - currentStepStart,
        depth: 1,
        color: "green",
        tooltipData: {
          kind: "step",
          stepNumber,
          turnNumber,
          toolCallCount: stepToolCallCount,
        },
      });
    }
  };

  for (const e of events) {
    const t = e.timestamp - t0;

    if (e.type === "TurnBegin") {
      closeGeneration(t);
      turnNumber++;
      currentTurnStart = t;
      currentTurnIndex = e.index;
      stepNumber = 0;
      turnStepCount = 0;
      turnToolCallCount = 0;
      // Extract user input for tooltip
      const input = e.payload.user_input;
      if (typeof input === "string") {
        turnUserInput = input.slice(0, 120);
      } else if (Array.isArray(input)) {
        const textPart = input.find(
          (p: Record<string, unknown>) => p.type === "text",
        );
        turnUserInput = textPart
          ? String(textPart.text ?? "").slice(0, 120)
          : "(multipart)";
      } else {
        turnUserInput = "";
      }
    } else if (e.type === "TurnEnd") {
      closeGeneration(t);
      closeStep(t);
      closeTurn(t);
      currentStepStart = null;
    } else if (e.type === "StepBegin") {
      closeGeneration(t);
      closeStep(t);
      stepNumber++;
      turnStepCount++;
      currentStepStart = t;
      currentStepIndex = e.index;
      stepToolCallCount = 0;
    } else if (e.type === "ToolCall") {
      closeGeneration(t);
      const id = e.payload.id as string | undefined;
      const fn = e.payload.function as Record<string, unknown> | undefined;
      const name = (fn?.name as string) ?? "tool";
      const args = (fn?.arguments as string) ?? "";
      let argsSummary = "";
      try {
        const parsed = JSON.parse(args);
        const keys = Object.keys(parsed);
        if (keys.length > 0) {
          const firstVal = String(parsed[keys[0]] ?? "");
          argsSummary = `${keys[0]}=${firstVal.slice(0, 60)}`;
        }
      } catch {
        argsSummary = args.slice(0, 60);
      }
      if (id) {
        openToolCalls.set(id, { name, startTime: t, eventIndex: e.index, argsSummary });
        turnToolCallCount++;
        stepToolCallCount++;
      }
    } else if (e.type === "ToolResult") {
      closeGeneration(t);
      const tcId = e.payload.tool_call_id as string | undefined;
      if (tcId && openToolCalls.has(tcId)) {
        const call = openToolCalls.get(tcId)!;
        const rv = e.payload.return_value as Record<string, unknown> | undefined;
        const hasError = rv?.is_error === true;
        bars.push({
          label: call.name,
          eventIndex: call.eventIndex,
          startSec: call.startTime,
          endSec: t,
          durationSec: t - call.startTime,
          depth: 2,
          color: "purple",
          hasError,
          tooltipData: {
            kind: "tool",
            toolName: call.name,
            toolCallId: tcId,
            hasError,
            argsSummary: call.argsSummary,
          },
        });
        openToolCalls.delete(tcId);
      }
    } else if (e.type === "ApprovalRequest") {
      const id = e.payload.id as string | undefined;
      if (id) {
        openApprovals.set(id, {
          startTime: t,
          eventIndex: e.index,
          sender: (e.payload.sender as string) ?? "",
          action: (e.payload.action as string) ?? "",
        });
      }
    } else if (e.type === "ApprovalResponse") {
      const reqId = e.payload.request_id as string | undefined;
      if (reqId && openApprovals.has(reqId)) {
        const req = openApprovals.get(reqId)!;
        const response = (e.payload.response as string) ?? "";
        bars.push({
          label: `Approval: ${req.action || req.sender || "wait"}`,
          eventIndex: req.eventIndex,
          startSec: req.startTime,
          endSec: t,
          durationSec: t - req.startTime,
          depth: 2,
          color: "amber",
          hasError: response === "reject",
          striped: true,
          tooltipData: {
            kind: "approval",
            sender: req.sender,
            action: req.action,
            response,
          },
        });
        openApprovals.delete(reqId);
      }
    } else if (e.type === "CompactionBegin") {
      compactionStart = t;
      compactionIndex = e.index;
    } else if (e.type === "CompactionEnd") {
      if (compactionStart !== null) {
        compactionMarkers.push({
          startSec: compactionStart,
          endSec: t,
          eventIndex: compactionIndex,
        });
        compactionStart = null;
      }
    } else if (e.type === "StatusUpdate") {
      const cu = e.payload.context_usage as number | undefined;
      const tu = e.payload.token_usage as
        | Record<string, number>
        | undefined;
      if (cu !== undefined || tu) {
        tokenData.push({
          timeSec: t,
          inputTokens: tu ? (tu.input_other ?? 0) + (tu.input_cache_read ?? 0) + (tu.input_cache_creation ?? 0) : 0,
          outputTokens: tu?.output ?? 0,
          contextUsage: cu ?? 0,
          eventIndex: e.index,
        });
      }
    } else if (e.type === "TextPart" || e.type === "ThinkPart") {
      if (genStart === null) {
        genStart = t;
        genIndex = e.index;
        genCharCount = 0;
        genIsThinking = e.type === "ThinkPart";
      }
      const text =
        e.type === "TextPart"
          ? ((e.payload.text as string) ?? "")
          : ((e.payload.thinking as string) ?? (e.payload.think as string) ?? "");
      genCharCount += text.length;
    } else if (e.type === "SubagentEvent") {
      const taskId = e.payload.parent_tool_call_id as string | undefined;
      if (taskId) {
        if (!subagentData.has(taskId)) {
          subagentData.set(taskId, {
            startTime: t, endTime: t, eventIndex: e.index, eventCount: 0,
            subagentType: (e.payload.subagent_type as string) ?? undefined,
            agentId: (e.payload.agent_id as string) ?? undefined,
          });
        }
        const sa = subagentData.get(taskId)!;
        sa.endTime = Math.max(sa.endTime, t);
        sa.startTime = Math.min(sa.startTime, t);
        sa.eventCount++;
      }
    }
  }

  // ── Close remaining open items ──
  const lastT = events.length > 0 ? events[events.length - 1].timestamp - t0 : 0;

  closeGeneration(lastT);
  closeStep(lastT);
  closeTurn(lastT);

  // Close unclosed compaction
  if (compactionStart !== null) {
    compactionMarkers.push({
      startSec: compactionStart,
      endSec: lastT,
      eventIndex: compactionIndex,
    });
  }

  // Close unclosed approvals
  for (const [, req] of openApprovals) {
    bars.push({
      label: `Approval: ${req.action || req.sender || "wait"}`,
      eventIndex: req.eventIndex,
      startSec: req.startTime,
      endSec: lastT,
      durationSec: lastT - req.startTime,
      depth: 2,
      color: "amber",
      striped: true,
      tooltipData: {
        kind: "approval",
        sender: req.sender,
        action: req.action,
        response: "(pending)",
      },
    });
  }

  // ── Build sub-agent bars ──
  const SUBAGENT_COLORS: Record<string, BarColor> = {
    coder: "violet",
    explore: "cyan",
    plan: "amber",
    "general-purpose": "blue",
  };
  for (const [taskId, sa] of subagentData) {
    if (sa.eventCount === 0) continue;
    const typeLabel = sa.subagentType ? ` [${sa.subagentType}]` : "";
    bars.push({
      label: `Sub-agent${typeLabel}`,
      eventIndex: sa.eventIndex,
      startSec: sa.startTime,
      endSec: sa.endTime,
      durationSec: sa.endTime - sa.startTime,
      depth: 3,
      color: (sa.subagentType && SUBAGENT_COLORS[sa.subagentType]) || "indigo",
      tooltipData: {
        kind: "subagent",
        taskToolCallId: taskId.slice(0, 12),
        eventCount: sa.eventCount,
        subagentType: sa.subagentType,
        agentId: sa.agentId?.slice(0, 8),
      },
    });
  }

  const totalSec =
    events.length >= 2
      ? events[events.length - 1].timestamp - events[0].timestamp
      : 0;

  // ── Compute gaps ──
  const gaps: GapIndicator[] = [];
  if (totalSec > 0) {
    const toolBars = bars
      .filter((b) => b.depth === 2)
      .sort((a, b) => a.startSec - b.startSec);
    for (let i = 1; i < toolBars.length; i++) {
      const prev = toolBars[i - 1];
      const curr = toolBars[i];
      const gap = curr.startSec - prev.endSec;
      if (gap > 2.0) {
        gaps.push({
          startSec: prev.endSec,
          endSec: curr.startSec,
          durationSec: gap,
          depth: 2,
        });
      }
    }
  }

  // Default sort: hierarchy
  bars.sort((a, b) => a.depth - b.depth || a.startSec - b.startSec);

  return { bars, totalSec, compactionMarkers, tokenData, gaps };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDuration(sec: number): string {
  if (sec < 0.001) return "<1ms";
  if (sec < 1) return `${(sec * 1000).toFixed(0)}ms`;
  if (sec < 60) return `${sec.toFixed(2)}s`;
  return `${(sec / 60).toFixed(1)}min`;
}

function computeTicks(
  rangeStart: number,
  rangeEnd: number,
): { sec: number; label: string }[] {
  const duration = rangeEnd - rangeStart;
  if (duration <= 0) return [];

  let interval: number;
  if (duration < 5) interval = 0.5;
  else if (duration < 15) interval = 1;
  else if (duration < 60) interval = 5;
  else if (duration < 300) interval = 30;
  else if (duration < 1800) interval = 60;
  else interval = 300;

  const ticks: { sec: number; label: string }[] = [];
  const start = Math.ceil(rangeStart / interval) * interval;
  for (let t = start; t <= rangeEnd; t += interval) {
    ticks.push({ sec: t, label: formatDuration(t) });
  }
  return ticks;
}

// ─── Color Map ──────────────────────────────────────────────────────────────

const COLOR_MAP: Record<string, { bg: string; text: string; border: string }> = {
  blue: {
    bg: "bg-blue-500/20",
    text: "text-blue-700 dark:text-blue-300",
    border: "border-blue-500/30",
  },
  purple: {
    bg: "bg-purple-500/20",
    text: "text-purple-700 dark:text-purple-300",
    border: "border-purple-500/30",
  },
  amber: {
    bg: "bg-amber-500/20",
    text: "text-amber-700 dark:text-amber-300",
    border: "border-amber-500/30",
  },
  green: {
    bg: "bg-green-500/20",
    text: "text-green-700 dark:text-green-300",
    border: "border-green-500/30",
  },
  cyan: {
    bg: "bg-cyan-500/20",
    text: "text-cyan-700 dark:text-cyan-300",
    border: "border-cyan-500/30",
  },
  indigo: {
    bg: "bg-indigo-500/20",
    text: "text-indigo-700 dark:text-indigo-300",
    border: "border-indigo-500/30",
  },
  violet: {
    bg: "bg-violet-500/20",
    text: "text-violet-700 dark:text-violet-300",
    border: "border-violet-500/30",
  },
};

// ─── Tooltip Content ────────────────────────────────────────────────────────

function BarTooltipContent({ bar }: { bar: TimelineBar }) {
  const d = bar.tooltipData;
  if (!d) return null;

  return (
    <div className="space-y-1">
      <div className="font-medium text-foreground">{bar.label}</div>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Timer className="w-3 h-3" />
        <span>{formatDuration(bar.durationSec)}</span>
      </div>

      {d.kind === "turn" && (
        <>
          <div className="text-muted-foreground">
            {d.stepCount} step{d.stepCount !== 1 ? "s" : ""}, {d.toolCallCount}{" "}
            tool call{d.toolCallCount !== 1 ? "s" : ""}
          </div>
          {d.userInput && (
            <div className="text-muted-foreground/80 italic truncate max-w-[240px]">
              &ldquo;{d.userInput}&rdquo;
            </div>
          )}
        </>
      )}

      {d.kind === "step" && (
        <div className="text-muted-foreground">
          Turn {d.turnNumber} &middot; {d.toolCallCount} tool call
          {d.toolCallCount !== 1 ? "s" : ""}
        </div>
      )}

      {d.kind === "tool" && (
        <>
          <div className="font-mono text-[10px] text-muted-foreground/70">
            {d.toolCallId.slice(0, 16)}
          </div>
          {d.argsSummary && (
            <div className="text-muted-foreground/80 truncate max-w-[240px] font-mono text-[10px]">
              {d.argsSummary}
            </div>
          )}
          {d.hasError && <div className="text-red-500 font-medium">Error</div>}
        </>
      )}

      {d.kind === "thinking" && (
        <div className="text-muted-foreground">
          {d.isThinking ? "Extended thinking" : "Text generation"} &middot;{" "}
          {d.charCount.toLocaleString()} chars
        </div>
      )}

      {d.kind === "approval" && (
        <>
          <div className="text-muted-foreground">
            {d.sender}: {d.action}
          </div>
          <div
            className={
              d.response === "reject"
                ? "text-red-500 font-medium"
                : "text-green-500 font-medium"
            }
          >
            {d.response === "approve"
              ? "Approved"
              : d.response === "approve_for_session"
                ? "Approved (session)"
                : d.response === "reject"
                  ? "Rejected"
                  : d.response}
          </div>
        </>
      )}

      {d.kind === "subagent" && (
        <>
          {d.subagentType && (
            <div className="font-medium text-indigo-600 dark:text-indigo-400">
              {d.subagentType}{d.agentId ? ` (${d.agentId})` : ""}
            </div>
          )}
          <div className="font-mono text-[10px] text-muted-foreground/70">
            task: {d.taskToolCallId}
          </div>
          <div className="text-muted-foreground">
            {d.eventCount} event{d.eventCount !== 1 ? "s" : ""}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Token Sparkline ────────────────────────────────────────────────────────

function TokenSparkline({
  tokenData,
  rangeStart,
  rangeDuration,
}: {
  tokenData: TokenDataPoint[];
  rangeStart: number;
  rangeDuration: number;
}) {
  if (tokenData.length < 2) return null;

  const W = 1000;
  const H = 24;
  const PAD_Y = 2;

  const maxTokens = Math.max(
    ...tokenData.map((d) => d.inputTokens + d.outputTokens),
    1,
  );

  const points = tokenData
    .filter((d) => d.timeSec >= rangeStart && d.timeSec <= rangeStart + rangeDuration)
    .map((d) => {
      const x = ((d.timeSec - rangeStart) / rangeDuration) * W;
      const y =
        H - PAD_Y - ((d.inputTokens + d.outputTokens) / maxTokens) * (H - PAD_Y * 2);
      return { x, y };
    });

  if (points.length < 2) return null;

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`)
    .join(" ");
  const areaPath = `${linePath} L${points[points.length - 1].x},${H} L${points[0].x},${H} Z`;

  // Context usage line
  const ctxPoints = tokenData
    .filter(
      (d) =>
        d.timeSec >= rangeStart &&
        d.timeSec <= rangeStart + rangeDuration &&
        d.contextUsage > 0,
    )
    .map((d) => {
      const x = ((d.timeSec - rangeStart) / rangeDuration) * W;
      const y = H - PAD_Y - d.contextUsage * (H - PAD_Y * 2);
      return { x, y };
    });

  const ctxPath =
    ctxPoints.length >= 2
      ? ctxPoints.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ")
      : null;

  return (
    <div className="flex items-center gap-2 h-6 mb-1">
      <div className="shrink-0 w-32" />
      <div className="flex-1 relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-6"
          preserveAspectRatio="none"
        >
          <path d={areaPath} className="fill-primary/8" />
          <path
            d={linePath}
            className="stroke-primary/40 fill-none"
            strokeWidth={1.5}
          />
          {ctxPath && (
            <path
              d={ctxPath}
              className="stroke-orange-400/50 fill-none"
              strokeWidth={1}
              strokeDasharray="3,2"
            />
          )}
        </svg>
      </div>
      <span className="text-[10px] font-mono text-muted-foreground w-16 shrink-0 text-right">
        tokens
      </span>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function TimelineView({ events, onScrollToIndex }: TimelineViewProps) {
  const result = useMemo(() => buildTimeline(events), [events]);
  const { totalSec, compactionMarkers, tokenData, gaps } = result;

  const [sortMode, setSortMode] = useState<SortMode>("hierarchy");
  const [viewRange, setViewRange] = useState<[number, number] | null>(null);
  const [showGaps, setShowGaps] = useState(false);
  const [showTokens, setShowTokens] = useState(false);

  // Zoom drag
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragCurrent, setDragCurrent] = useState<number | null>(null);
  const trackContainerRef = useRef<HTMLDivElement>(null);

  const rangeStart = viewRange ? viewRange[0] : 0;
  const rangeEnd = viewRange ? viewRange[1] : totalSec;
  const rangeDuration = rangeEnd - rangeStart;
  const isZoomed = viewRange !== null;
  const LABEL_W = 128;

  const sortedBars = useMemo(() => {
    const b = [...result.bars];
    if (sortMode === "chronological") {
      b.sort((a, c) => a.startSec - c.startSec || a.depth - c.depth);
    }
    return b;
  }, [result.bars, sortMode]);

  const visibleBars = useMemo(() => {
    if (!isZoomed) return sortedBars;
    return sortedBars.filter(
      (bar) => bar.endSec > rangeStart && bar.startSec < rangeEnd,
    );
  }, [sortedBars, isZoomed, rangeStart, rangeEnd]);

  const ticks = useMemo(
    () => computeTicks(rangeStart, rangeEnd),
    [rangeStart, rangeEnd],
  );

  // ── Zoom handlers ──
  const getTimeFromMouseEvent = useCallback(
    (e: React.MouseEvent) => {
      const container = trackContainerRef.current;
      if (!container) return null;
      // Find the first bar track element to get the correct offset
      const barTrack = container.querySelector("[data-bar-track]");
      if (!barTrack) return null;
      const rect = barTrack.getBoundingClientRect();
      const xPct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      return rangeStart + xPct * rangeDuration;
    },
    [rangeStart, rangeDuration],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const t = getTimeFromMouseEvent(e);
      if (t !== null) {
        setDragStart(t);
        setDragCurrent(t);
      }
    },
    [getTimeFromMouseEvent],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (dragStart === null) return;
      const t = getTimeFromMouseEvent(e);
      if (t !== null) setDragCurrent(t);
    },
    [dragStart, getTimeFromMouseEvent],
  );

  const handleMouseUp = useCallback(() => {
    if (dragStart !== null && dragCurrent !== null) {
      const lo = Math.min(dragStart, dragCurrent);
      const hi = Math.max(dragStart, dragCurrent);
      if (hi - lo > rangeDuration * 0.01) {
        setViewRange([lo, hi]);
      }
    }
    setDragStart(null);
    setDragCurrent(null);
  }, [dragStart, dragCurrent, rangeDuration]);

  const zoomBy = useCallback(
    (factor: number) => {
      const center = rangeStart + rangeDuration / 2;
      const newDuration = Math.min(totalSec, rangeDuration * factor);
      if (newDuration < 0.01) return;

      const newStart = Math.max(0, center - newDuration / 2);
      const newEnd = Math.min(totalSec, newStart + newDuration);

      if (newEnd - newStart >= totalSec * 0.99) {
        setViewRange(null);
      } else {
        setViewRange([newStart, newEnd]);
      }
    },
    [rangeStart, rangeDuration, totalSec],
  );

  const resetZoom = useCallback(() => setViewRange(null), []);

  if (result.bars.length === 0 || totalSec === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Not enough data for timeline
      </div>
    );
  }

  // Drag selection
  const dragLeftPct =
    dragStart !== null && dragCurrent !== null
      ? ((Math.min(dragStart, dragCurrent) - rangeStart) / rangeDuration) * 100
      : 0;
  const dragWidthPct =
    dragStart !== null && dragCurrent !== null
      ? (Math.abs(dragCurrent - dragStart) / rangeDuration) * 100
      : 0;

  return (
    <Tooltip.Provider delayDuration={200}>
      <div className="h-full overflow-auto p-4">
        {/* ── Header ── */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="text-xs font-medium text-muted-foreground">
            Total: {formatDuration(totalSec)}
          </span>

          {/* Sort mode toggle */}
          <div className="flex items-center border rounded-md overflow-hidden ml-3">
            <button
              onClick={() => setSortMode("hierarchy")}
              className={`px-2 py-1 text-xs flex items-center gap-1 transition-colors ${
                sortMode === "hierarchy"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted"
              }`}
              title="Group by hierarchy (Turn > Step > Tool)"
            >
              <Layers className="w-3 h-3" />
              Hierarchy
            </button>
            <button
              onClick={() => setSortMode("chronological")}
              className={`px-2 py-1 text-xs flex items-center gap-1 transition-colors ${
                sortMode === "chronological"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted"
              }`}
              title="Sort by start time"
            >
              <ArrowDownNarrowWide className="w-3 h-3" />
              Timeline
            </button>
          </div>

          {/* Gap toggle */}
          {gaps.length > 0 && (
            <button
              onClick={() => setShowGaps((v) => !v)}
              className={`px-2 py-1 text-xs rounded-md border flex items-center gap-1 transition-colors ${
                showGaps
                  ? "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30"
                  : "text-muted-foreground hover:bg-muted"
              }`}
              title={`Show idle gaps (${gaps.length})`}
            >
              <Timer className="w-3 h-3" />
              Gaps ({gaps.length})
            </button>
          )}

          {/* Token sparkline toggle */}
          {tokenData.length >= 2 && (
            <button
              onClick={() => setShowTokens((v) => !v)}
              className={`px-2 py-1 text-xs rounded-md border flex items-center gap-1 transition-colors ${
                showTokens
                  ? "bg-primary/10 text-primary border-primary/30"
                  : "text-muted-foreground hover:bg-muted"
              }`}
              title="Show token usage"
            >
              <Activity className="w-3 h-3" />
              Tokens
            </button>
          )}

          {/* Zoom controls */}
          <div className="flex items-center border rounded-md overflow-hidden ml-1">
            <button
              onClick={() => zoomBy(0.5)}
              className="px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted transition-colors"
              title="Zoom in"
            >
              <ZoomIn className="w-3 h-3" />
            </button>
            <button
              onClick={() => zoomBy(2)}
              className="px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted transition-colors border-l"
              title="Zoom out"
            >
              <ZoomOut className="w-3 h-3" />
            </button>
            {isZoomed && (
              <button
                onClick={resetZoom}
                className="px-2 py-1 text-xs text-muted-foreground hover:bg-muted transition-colors border-l"
                title="Reset zoom"
              >
                Reset
              </button>
            )}
          </div>

          {/* Legend */}
          <div className="flex items-center gap-3 ml-auto">
            <Legend color="blue" label="Turn" />
            <Legend color="green" label="Step" />
            <Legend color="purple" label="Tool" />
            <Legend color="cyan" label="Generation" />
            <Legend color="amber" label="Approval" />
            {result.bars.some((b) => b.color === "indigo") && (
              <Legend color="indigo" label="Sub-agent" />
            )}
          </div>
        </div>

        {/* ── Token Sparkline ── */}
        {showTokens && (
          <TokenSparkline
            tokenData={tokenData}
            rangeStart={rangeStart}
            rangeDuration={rangeDuration}
          />
        )}

        {/* ── Time Ruler ── */}
        <div className="flex items-center h-4 mb-1">
          <div className="shrink-0 w-32" />
          <div className="flex-1 relative h-full border-b border-muted/30">
            {ticks.map((tick) => {
              const leftPct = ((tick.sec - rangeStart) / rangeDuration) * 100;
              if (leftPct < 0 || leftPct > 100) return null;
              return (
                <div
                  key={tick.sec}
                  className="absolute top-0 h-full"
                  style={{ left: `${leftPct}%` }}
                >
                  <div className="w-px h-full bg-muted-foreground/15" />
                  <span className="absolute top-0 ml-1 text-[8px] text-muted-foreground/60 whitespace-nowrap">
                    {tick.label}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="shrink-0 w-16" />
        </div>

        {/* ── Bar Area ── */}
        <div
          ref={trackContainerRef}
          className="relative select-none"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            if (dragStart !== null) handleMouseUp();
          }}
        >
          {/* Compaction marker overlays */}
          {compactionMarkers.map((c) => {
            const leftPct = ((c.startSec - rangeStart) / rangeDuration) * 100;
            const widthPct = Math.max(
              ((c.endSec - c.startSec) / rangeDuration) * 100,
              0.3,
            );
            if (leftPct > 100 || leftPct + widthPct < 0) return null;
            return (
              <Tooltip.Root key={`c-${c.eventIndex}`}>
                <Tooltip.Trigger asChild>
                  <div
                    className="absolute top-0 bottom-0 bg-orange-500/8 border-l border-dashed border-orange-500/40 z-10 cursor-pointer hover:bg-orange-500/15 transition-colors"
                    style={{
                      left: `calc(${LABEL_W}px + (100% - ${LABEL_W}px - 72px) * ${leftPct / 100})`,
                      width: `calc((100% - ${LABEL_W}px - 72px) * ${widthPct / 100})`,
                    }}
                    onClick={() => onScrollToIndex(c.eventIndex)}
                  />
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md z-50"
                    sideOffset={5}
                  >
                    <div className="font-medium text-orange-600 dark:text-orange-400">
                      Compaction
                    </div>
                    <div className="text-muted-foreground">
                      {formatDuration(c.endSec - c.startSec)}
                    </div>
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            );
          })}

          {/* Tick gridlines */}
          {ticks.map((tick) => {
            const leftPct = ((tick.sec - rangeStart) / rangeDuration) * 100;
            if (leftPct < 0 || leftPct > 100) return null;
            return (
              <div
                key={`grid-${tick.sec}`}
                className="absolute top-0 bottom-0 pointer-events-none z-0"
                style={{
                  left: `calc(${LABEL_W}px + (100% - ${LABEL_W}px - 72px) * ${leftPct / 100})`,
                }}
              >
                <div className="w-px h-full bg-muted-foreground/5" />
              </div>
            );
          })}

          {/* Drag selection overlay */}
          {dragStart !== null && dragCurrent !== null && dragWidthPct > 0.5 && (
            <div
              className="absolute top-0 bottom-0 bg-blue-500/10 border border-blue-500/30 rounded-sm pointer-events-none z-20"
              style={{
                left: `calc(${LABEL_W}px + (100% - ${LABEL_W}px - 72px) * ${dragLeftPct / 100})`,
                width: `calc((100% - ${LABEL_W}px - 72px) * ${dragWidthPct / 100})`,
              }}
            />
          )}

          {/* Bars */}
          <div className="space-y-0.5">
            {visibleBars.map((bar, i) => {
              const leftPct = Math.max(
                0,
                ((bar.startSec - rangeStart) / rangeDuration) * 100,
              );
              const rightClamp = Math.min(bar.endSec, rangeEnd);
              const leftClamp = Math.max(bar.startSec, rangeStart);
              const widthPct = Math.max(
                ((rightClamp - leftClamp) / rangeDuration) * 100,
                0.5,
              );
              const colors = COLOR_MAP[bar.color] ?? COLOR_MAP.blue;
              const indent =
                sortMode === "hierarchy" ? bar.depth * 16 : bar.depth * 8;

              return (
                <Tooltip.Root key={`${bar.eventIndex}-${i}`}>
                  <Tooltip.Trigger asChild>
                    <div
                      className="flex items-center gap-2 h-6 group cursor-pointer"
                      style={{ paddingLeft: `${indent}px` }}
                      onClick={() => onScrollToIndex(bar.eventIndex)}
                    >
                      {/* Label */}
                      <span
                        className={`text-[11px] font-mono shrink-0 truncate ${colors.text} ${bar.hasError ? "text-red-600 dark:text-red-400" : ""}`}
                        style={{ width: `${LABEL_W - indent}px` }}
                      >
                        {bar.label}
                      </span>

                      {/* Bar track */}
                      <div
                        className="flex-1 relative h-4 bg-muted/20 rounded-sm overflow-hidden"
                        data-bar-track
                      >
                        <div
                          className={`absolute top-0 h-full rounded-sm border ${colors.bg} ${colors.border} ${
                            bar.hasError
                              ? "bg-red-500/20 border-red-500/30"
                              : ""
                          } ${bar.dashed ? "border-dashed" : ""} group-hover:brightness-125 transition-all`}
                          style={{
                            left: `${leftPct}%`,
                            width: `${widthPct}%`,
                            minWidth: "2px",
                            ...(bar.striped
                              ? {
                                  backgroundImage:
                                    "repeating-linear-gradient(135deg, transparent, transparent 3px, rgba(245,158,11,0.15) 3px, rgba(245,158,11,0.15) 6px)",
                                }
                              : {}),
                          }}
                        />
                      </div>

                      {/* Duration */}
                      <span className="text-[10px] font-mono text-muted-foreground w-16 shrink-0 text-right">
                        {formatDuration(bar.durationSec)}
                      </span>
                    </div>
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content
                      className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md z-50 max-w-xs"
                      sideOffset={5}
                    >
                      <BarTooltipContent bar={bar} />
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>
              );
            })}
          </div>

          {/* Gap indicators */}
          {showGaps &&
            gaps.map((gap, i) => {
              const leftPct = Math.max(
                0,
                ((gap.startSec - rangeStart) / rangeDuration) * 100,
              );
              const widthPct = Math.max(
                (gap.durationSec / rangeDuration) * 100,
                0.5,
              );
              if (leftPct > 100) return null;
              const indent =
                sortMode === "hierarchy" ? gap.depth * 16 : gap.depth * 8;
              return (
                <div
                  key={`gap-${i}`}
                  className="flex items-center gap-2 h-5"
                  style={{ paddingLeft: `${indent}px` }}
                >
                  <div
                    className="shrink-0"
                    style={{ width: `${LABEL_W - indent}px` }}
                  />
                  <div className="flex-1 relative h-3">
                    <div
                      className="absolute top-0 h-full rounded-sm border border-dashed border-red-400/30 bg-red-500/5 flex items-center justify-center"
                      style={{
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                        minWidth: "20px",
                      }}
                    >
                      <span className="text-[8px] font-mono text-red-400/70 px-1">
                        idle {formatDuration(gap.durationSec)}
                      </span>
                    </div>
                  </div>
                  <div className="shrink-0 w-16" />
                </div>
              );
            })}
        </div>

        {/* ── Zoom hint ── */}
        {!isZoomed && (
          <div className="text-[10px] text-muted-foreground/40 mt-2 text-center">
            Drag to zoom &middot; Click bar to jump to event
          </div>
        )}
      </div>
    </Tooltip.Provider>
  );
}

// ─── Legend ──────────────────────────────────────────────────────────────────

function Legend({ color, label }: { color: string; label: string }) {
  const colors = COLOR_MAP[color] ?? COLOR_MAP.blue;
  return (
    <div className="flex items-center gap-1">
      <div
        className={`w-3 h-2 rounded-sm ${colors.bg} border ${colors.border}`}
      />
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}
