import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import type { WireEvent } from "@/lib/api";

// ─── Types ──────────────────────────────────────────────────────────────────

interface TurnEfficiencyProps {
  events: WireEvent[];
  onScrollToIndex: (idx: number) => void;
}

interface TurnMetrics {
  turnNumber: number;
  eventIndex: number;
  stepCount: number;
  toolCallCount: number;
  inputTokensDelta: number;
  outputTokensDelta: number;
  durationSec: number;
  isAnomaly: boolean;
  anomalyReasons: string[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDuration(sec: number): string {
  if (sec < 0.001) return "<1ms";
  if (sec < 1) return `${(sec * 1000).toFixed(0)}ms`;
  if (sec < 60) return `${sec.toFixed(2)}s`;
  return `${(sec / 60).toFixed(1)}min`;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[], avg: number): number {
  if (values.length === 0) return 0;
  const variance =
    values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// ─── Computation ────────────────────────────────────────────────────────────

function computeTurnMetrics(events: WireEvent[]): TurnMetrics[] {
  const raw: Omit<TurnMetrics, "isAnomaly" | "anomalyReasons">[] = [];

  let turnNumber = 0;
  let turnStartIndex = -1;
  let turnStartTimestamp = 0;
  let stepCount = 0;
  let toolCallCount = 0;
  let turnInputTokens = 0;
  let turnOutputTokens = 0;
  let inTurn = false;

  for (const event of events) {
    // Accumulate token usage within the current turn
    if (event.type === "StatusUpdate" && inTurn) {
      const usage = event.payload.token_usage as Record<string, number> | undefined;
      if (usage) {
        turnInputTokens += (usage.input_other ?? 0) + (usage.input_cache_read ?? 0) + (usage.input_cache_creation ?? 0);
        turnOutputTokens += usage.output ?? 0;
      }
    }
    // Also count tokens from SubagentEvent-wrapped StatusUpdate
    if (event.type === "SubagentEvent" && inTurn) {
      const inner = event.payload.event as Record<string, unknown> | undefined;
      if (inner?.type === "StatusUpdate") {
        const innerPayload = inner.payload as Record<string, unknown> | undefined;
        const usage = innerPayload?.token_usage as Record<string, number> | undefined;
        if (usage) {
          turnInputTokens += (usage.input_other ?? 0) + (usage.input_cache_read ?? 0) + (usage.input_cache_creation ?? 0);
          turnOutputTokens += usage.output ?? 0;
        }
      }
    }

    if (event.type === "TurnBegin") {
      turnNumber++;
      turnStartIndex = event.index;
      turnStartTimestamp = event.timestamp;
      stepCount = 0;
      toolCallCount = 0;
      turnInputTokens = 0;
      turnOutputTokens = 0;
      inTurn = true;
    } else if (event.type === "StepBegin" && inTurn) {
      stepCount++;
    } else if (event.type === "ToolCall" && inTurn) {
      toolCallCount++;
    } else if (event.type === "TurnEnd" && inTurn) {
      const durationSec = event.timestamp - turnStartTimestamp;
      raw.push({
        turnNumber,
        eventIndex: turnStartIndex,
        stepCount,
        toolCallCount,
        inputTokensDelta: turnInputTokens,
        outputTokensDelta: turnOutputTokens,
        durationSec: durationSec > 0 ? durationSec : 0,
      });
      inTurn = false;
    }
  }

  // Handle unclosed turn
  if (inTurn) {
    const lastEvent = events[events.length - 1];
    const durationSec = lastEvent
      ? lastEvent.timestamp - turnStartTimestamp
      : 0;
    raw.push({
      turnNumber,
      eventIndex: turnStartIndex,
      stepCount,
      toolCallCount,
      inputTokensDelta: turnInputTokens,
      outputTokensDelta: turnOutputTokens,
      durationSec: durationSec > 0 ? durationSec : 0,
    });
  }

  if (raw.length === 0) return [];

  // Anomaly detection: mean + 2*stddev for stepCount and totalTokens
  const stepCounts = raw.map((t) => t.stepCount);
  const totalTokens = raw.map(
    (t) => t.inputTokensDelta + t.outputTokensDelta,
  );

  const stepMean = mean(stepCounts);
  const stepStd = stddev(stepCounts, stepMean);
  const stepThreshold = stepMean + 2 * stepStd;

  const tokenMean = mean(totalTokens);
  const tokenStd = stddev(totalTokens, tokenMean);
  const tokenThreshold = tokenMean + 2 * tokenStd;

  return raw.map((t) => {
    const reasons: string[] = [];
    const total = t.inputTokensDelta + t.outputTokensDelta;

    if (stepStd > 0 && t.stepCount > stepThreshold) {
      reasons.push(
        `Steps (${t.stepCount}) > μ+2σ (${stepThreshold.toFixed(1)})`,
      );
    }
    if (tokenStd > 0 && total > tokenThreshold) {
      reasons.push(
        `Tokens (${total.toLocaleString()}) > μ+2σ (${tokenThreshold.toFixed(0)})`,
      );
    }

    return {
      ...t,
      isAnomaly: reasons.length > 0,
      anomalyReasons: reasons,
    };
  });
}

// ─── Component ──────────────────────────────────────────────────────────────

export function TurnEfficiency({ events, onScrollToIndex }: TurnEfficiencyProps) {
  const turns = useMemo(() => computeTurnMetrics(events), [events]);

  if (turns.length === 0) {
    return (
      <div className="border-t px-3 py-2 text-xs text-muted-foreground">
        No turn data available.
      </div>
    );
  }

  const anomalyCount = turns.filter((t) => t.isAnomaly).length;

  return (
    <div className="border-t">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground border-b bg-muted/30">
        <span className="font-medium text-foreground">Turn Efficiency</span>
        <span>
          {turns.length} turn{turns.length !== 1 && "s"}
        </span>
        {anomalyCount > 0 && (
          <span className="flex items-center gap-1 text-amber-500">
            <AlertTriangle className="h-3 w-3" />
            {anomalyCount} anomal{anomalyCount !== 1 ? "ies" : "y"}
          </span>
        )}
      </div>
      <div className="max-h-[240px] overflow-auto">
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 bg-background">
            <tr className="text-left text-muted-foreground">
              <th className="px-2 py-1 font-medium">Turn</th>
              <th className="px-2 py-1 font-medium text-right">Steps</th>
              <th className="px-2 py-1 font-medium text-right">Tools</th>
              <th className="px-2 py-1 font-medium text-right">Input Tokens</th>
              <th className="px-2 py-1 font-medium text-right">Output Tokens</th>
              <th className="px-2 py-1 font-medium text-right">Duration</th>
              <th className="px-2 py-1 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {turns.map((turn) => (
              <tr
                key={turn.turnNumber}
                className={`cursor-pointer border-t border-border/50 hover:bg-muted/50 transition-colors ${
                  turn.isAnomaly ? "bg-amber-500/10" : ""
                }`}
                onClick={() => onScrollToIndex(turn.eventIndex)}
              >
                <td className="px-2 py-1 font-mono text-xs">
                  #{turn.turnNumber}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {turn.stepCount}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {turn.toolCallCount}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {turn.inputTokensDelta.toLocaleString()}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {turn.outputTokensDelta.toLocaleString()}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {formatDuration(turn.durationSec)}
                </td>
                <td className="px-2 py-1">
                  {turn.isAnomaly ? (
                    <span className="group relative inline-flex items-center gap-1 text-amber-500">
                      <AlertTriangle className="h-3 w-3" />
                      <span className="text-[10px]">anomaly</span>
                      <span className="pointer-events-none absolute bottom-full left-0 z-10 mb-1 hidden w-48 rounded border bg-popover p-1.5 text-[10px] text-popover-foreground shadow-md group-hover:block">
                        {turn.anomalyReasons.map((r, i) => (
                          <div key={i}>{r}</div>
                        ))}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">ok</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
