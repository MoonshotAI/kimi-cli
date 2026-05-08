import { useMemo, useState } from "react";
import type { WireEvent } from "@/lib/api";

interface ToolStat {
  name: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgDurationSec: number;
  minDurationSec: number;
  maxDurationSec: number;
}

interface ToolStatsDashboardProps {
  events: WireEvent[];
  onScrollToIndex: (idx: number) => void;
}

type SortMode = "failureRate" | "callCount";

function formatDuration(sec: number): string {
  if (sec < 0.001) return "<1ms";
  if (sec < 1) return `${Math.round(sec * 1000)}ms`;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${(sec / 60).toFixed(1)}min`;
}

function rateColorClass(rate: number): string {
  if (rate > 80) return "text-green-500";
  if (rate >= 50) return "text-amber-500";
  return "text-red-500";
}

export function ToolStatsDashboard({ events, onScrollToIndex }: ToolStatsDashboardProps) {
  const [sortMode, setSortMode] = useState<SortMode>("failureRate");

  const stats = useMemo(() => {
    // Track open tool calls: toolCallId -> { name, startTimestamp, eventIndex }
    const openCalls = new Map<
      string,
      { name: string; startTimestamp: number; eventIndex: number }
    >();

    // Aggregate per tool name
    const agg = new Map<
      string,
      {
        totalCalls: number;
        successCount: number;
        failureCount: number;
        durations: number[];
      }
    >();

    for (const e of events) {
      if (e.type === "ToolCall") {
        const id = e.payload.id as string | undefined;
        const fn = e.payload.function as
          | { name: string; arguments?: string }
          | undefined;
        if (id && fn?.name) {
          openCalls.set(id, {
            name: fn.name,
            startTimestamp: e.timestamp,
            eventIndex: e.index,
          });
        }
      } else if (e.type === "ToolResult") {
        const tcId = e.payload.tool_call_id as string | undefined;
        if (!tcId) continue;
        const open = openCalls.get(tcId);
        if (!open) continue;

        const duration = Math.max(0, e.timestamp - open.startTimestamp);
        const returnValue = e.payload.return_value as
          | { is_error?: boolean }
          | undefined;
        const isError = returnValue?.is_error === true;

        let entry = agg.get(open.name);
        if (!entry) {
          entry = { totalCalls: 0, successCount: 0, failureCount: 0, durations: [] };
          agg.set(open.name, entry);
        }
        entry.totalCalls++;
        if (isError) {
          entry.failureCount++;
        } else {
          entry.successCount++;
        }
        entry.durations.push(duration);

        openCalls.delete(tcId);
      }
    }

    const result: ToolStat[] = [];
    for (const [name, data] of agg) {
      const durations = data.durations;
      const avg =
        durations.length > 0
          ? durations.reduce((s, d) => s + d, 0) / durations.length
          : 0;
      const min = durations.length > 0 ? Math.min(...durations) : 0;
      const max = durations.length > 0 ? Math.max(...durations) : 0;

      result.push({
        name,
        totalCalls: data.totalCalls,
        successCount: data.successCount,
        failureCount: data.failureCount,
        successRate:
          data.totalCalls > 0
            ? (data.successCount / data.totalCalls) * 100
            : 0,
        avgDurationSec: avg,
        minDurationSec: min,
        maxDurationSec: max,
      });
    }

    return result;
  }, [events]);

  const sorted = useMemo(() => {
    const copy = [...stats];
    if (sortMode === "failureRate") {
      // Failure rate descending (higher failure rate first)
      copy.sort((a, b) => {
        const aFailRate = a.totalCalls > 0 ? a.failureCount / a.totalCalls : 0;
        const bFailRate = b.totalCalls > 0 ? b.failureCount / b.totalCalls : 0;
        return bFailRate - aFailRate;
      });
    } else {
      copy.sort((a, b) => b.totalCalls - a.totalCalls);
    }
    return copy;
  }, [stats, sortMode]);

  if (sorted.length === 0) return null;

  return (
    <div className="border-b px-4 py-2 shrink-0">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] font-medium text-muted-foreground">
          Tool Call Success Rates
        </span>
        <span className="text-[10px] text-muted-foreground">
          ({sorted.length} tools)
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setSortMode("failureRate")}
            className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
              sortMode === "failureRate"
                ? "bg-primary/10 text-primary border-primary/30"
                : "text-muted-foreground border-transparent hover:text-foreground"
            }`}
          >
            By Failure
          </button>
          <button
            onClick={() => setSortMode("callCount")}
            className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
              sortMode === "callCount"
                ? "bg-primary/10 text-primary border-primary/30"
                : "text-muted-foreground border-transparent hover:text-foreground"
            }`}
          >
            By Count
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-muted-foreground text-left">
              <th className="font-medium pr-3 py-0.5">Tool Name</th>
              <th className="font-medium px-2 py-0.5 text-right">Calls</th>
              <th className="font-medium px-2 py-0.5 text-right">Success</th>
              <th className="font-medium px-2 py-0.5 text-right">Fail</th>
              <th className="font-medium px-2 py-0.5 text-right">Rate</th>
              <th className="font-medium px-2 py-0.5 text-right">Avg</th>
              <th className="font-medium px-2 py-0.5 text-right">Min</th>
              <th className="font-medium pl-2 py-0.5 text-right">Max</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((tool) => {
              const failureRate =
                tool.totalCalls > 0
                  ? (tool.failureCount / tool.totalCalls) * 100
                  : 0;
              const rowHighlight =
                failureRate > 20 ? "bg-red-500/10" : "";

              return (
                <tr
                  key={tool.name}
                  className={`${rowHighlight} hover:bg-muted/30 transition-colors`}
                >
                  <td className="pr-3 py-0.5 text-foreground truncate max-w-[180px]">
                    {tool.name}
                  </td>
                  <td className="px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                    {tool.totalCalls}
                  </td>
                  <td className="px-2 py-0.5 text-right tabular-nums text-green-500">
                    {tool.successCount}
                  </td>
                  <td className="px-2 py-0.5 text-right tabular-nums text-red-500">
                    {tool.failureCount}
                  </td>
                  <td
                    className={`px-2 py-0.5 text-right tabular-nums font-medium ${rateColorClass(tool.successRate)}`}
                  >
                    {tool.successRate.toFixed(0)}%
                  </td>
                  <td className="px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                    {formatDuration(tool.avgDurationSec)}
                  </td>
                  <td className="px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                    {formatDuration(tool.minDurationSec)}
                  </td>
                  <td className="pl-2 py-0.5 text-right tabular-nums text-muted-foreground">
                    {formatDuration(tool.maxDurationSec)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
