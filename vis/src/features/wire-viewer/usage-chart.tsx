import { useMemo, useRef } from "react";
import type { WireEvent } from "@/lib/api";

/* ------------------------------------------------------------------ */
/*  ToolTokenBreakdown – horizontal bar chart of tokens per tool      */
/* ------------------------------------------------------------------ */

interface ToolTokenBreakdownProps {
  events: WireEvent[];
}

interface ToolStats {
  input: number;
  output: number;
  calls: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function ToolTokenBreakdown({ events }: ToolTokenBreakdownProps) {
  const breakdown = useMemo(() => {
    const byTool = new Map<string, ToolStats>();

    // Track cumulative token totals from the most recent StatusUpdate
    let lastInputTotal = 0;
    let lastOutputTotal = 0;

    // Open tool calls: id -> { name, inputAtStart, outputAtStart }
    const openCalls = new Map<
      string,
      { name: string; inputAtStart: number; outputAtStart: number }
    >();

    for (const e of events) {
      if (e.type === "StatusUpdate") {
        const tu = e.payload.token_usage as Record<string, number> | undefined;
        if (tu) {
          lastInputTotal += (tu.input_other ?? 0) + (tu.input_cache_read ?? 0) + (tu.input_cache_creation ?? 0);
          lastOutputTotal += tu.output ?? 0;
        }
      } else if (e.type === "ToolCall") {
        const id = e.payload.id as string;
        const fn = e.payload.function as
          | { name: string; arguments: string }
          | undefined;
        if (id && fn?.name) {
          openCalls.set(id, {
            name: fn.name,
            inputAtStart: lastInputTotal,
            outputAtStart: lastOutputTotal,
          });
        }
      } else if (e.type === "ToolResult") {
        const toolCallId = e.payload.tool_call_id as string;
        const open = openCalls.get(toolCallId);
        if (open) {
          const inputDelta = Math.max(0, lastInputTotal - open.inputAtStart);
          const outputDelta = Math.max(0, lastOutputTotal - open.outputAtStart);

          const existing = byTool.get(open.name) || {
            input: 0,
            output: 0,
            calls: 0,
          };
          existing.input += inputDelta;
          existing.output += outputDelta;
          existing.calls += 1;
          byTool.set(open.name, existing);

          openCalls.delete(toolCallId);
        }
      }
    }

    // Sort by total tokens descending
    const sorted = Array.from(byTool.entries())
      .map(([name, stats]) => ({ name, ...stats, total: stats.input + stats.output }))
      .sort((a, b) => b.total - a.total);

    return sorted;
  }, [events]);

  if (breakdown.length === 0) return null;

  const grandTotal = breakdown.reduce((sum, t) => sum + t.total, 0);
  const maxTotal = breakdown[0].total;

  return (
    <div className="border-b px-4 py-2 shrink-0">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] font-medium text-muted-foreground">
          Token Usage by Tool
        </span>
        <span className="text-[10px] text-muted-foreground">
          ({formatTokens(grandTotal)} total)
        </span>
      </div>

      <div className="flex flex-col gap-1">
        {breakdown.map((tool) => {
          const barWidthPct = maxTotal > 0 ? (tool.total / maxTotal) * 100 : 0;
          const inputPct = tool.total > 0 ? (tool.input / tool.total) * 100 : 0;
          const outputPct = tool.total > 0 ? (tool.output / tool.total) * 100 : 0;

          return (
            <div key={tool.name} className="flex items-center gap-2">
              {/* Tool name + call count */}
              <div className="w-[140px] shrink-0 text-right pr-1">
                <span className="text-[11px] text-foreground truncate">
                  {tool.name}
                </span>
                <span className="text-[10px] text-muted-foreground ml-1">
                  x{tool.calls}
                </span>
              </div>

              {/* Bar */}
              <div className="flex-1 h-3 bg-muted/30 rounded-sm overflow-hidden">
                <div
                  className="h-full flex rounded-sm"
                  style={{ width: `${barWidthPct}%` }}
                >
                  {/* Input tokens – blue */}
                  <div
                    className="h-full bg-blue-500/70"
                    style={{ width: `${inputPct}%` }}
                  />
                  {/* Output tokens – green */}
                  <div
                    className="h-full bg-green-500/70"
                    style={{ width: `${outputPct}%` }}
                  />
                </div>
              </div>

              {/* Token count */}
              <span className="w-[56px] shrink-0 text-[10px] text-muted-foreground text-right tabular-nums">
                {formatTokens(tool.total)}
              </span>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 mt-1.5">
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-sm bg-blue-500/70" />
          <span className="text-[10px] text-muted-foreground">Input</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-sm bg-green-500/70" />
          <span className="text-[10px] text-muted-foreground">Output</span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  UsageChart – existing SVG line chart (unchanged)                  */
/* ------------------------------------------------------------------ */

interface UsageChartProps {
  events: WireEvent[];
  onScrollToIndex: (eventIndex: number) => void;
}

interface DataPoint {
  eventIndex: number;
  x: number; // normalized 0-1
  contextUsage: number; // 0-1
}

interface CompactionMark {
  eventIndex: number;
  x: number;
}

const CHART_HEIGHT = 80;
const CHART_PADDING_X = 32;
const CHART_PADDING_TOP = 8;
const CHART_PADDING_BOTTOM = 16;

export function UsageChart({ events, onScrollToIndex }: UsageChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  const { dataPoints, compactions } = useMemo(() => {
    const points: DataPoint[] = [];
    const comps: CompactionMark[] = [];
    const total = events.length;
    if (total === 0) return { dataPoints: points, compactions: comps };

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.type === "StatusUpdate" && e.payload.context_usage != null) {
        points.push({
          eventIndex: e.index,
          x: total > 1 ? i / (total - 1) : 0.5,
          contextUsage: e.payload.context_usage as number,
        });
      }
      if (e.type === "CompactionBegin") {
        comps.push({
          eventIndex: e.index,
          x: total > 1 ? i / (total - 1) : 0.5,
        });
      }
    }
    return { dataPoints: points, compactions: comps };
  }, [events]);

  if (dataPoints.length < 2) return null;

  const chartWidth = 600;
  const innerWidth = chartWidth - CHART_PADDING_X * 2;
  const innerHeight =
    CHART_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM;

  const toSvgX = (x: number) => CHART_PADDING_X + x * innerWidth;
  const toSvgY = (usage: number) =>
    CHART_PADDING_TOP + (1 - usage) * innerHeight;

  // Build polyline path
  const linePath = dataPoints
    .map((p, i) => {
      const x = toSvgX(p.x);
      const y = toSvgY(p.contextUsage);
      return `${i === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");

  // Build fill area (under the line, above the baseline)
  const areaPath =
    linePath +
    ` L ${toSvgX(dataPoints[dataPoints.length - 1].x)} ${toSvgY(0)}` +
    ` L ${toSvgX(dataPoints[0].x)} ${toSvgY(0)} Z`;

  // 80% danger zone
  const dangerY = toSvgY(0.8);

  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const svgWidth = rect.width;
    const clickX = e.clientX - rect.left;
    // Convert to normalized x
    const scale = chartWidth / svgWidth;
    const scaledX = clickX * scale;
    const normalizedX = (scaledX - CHART_PADDING_X) / innerWidth;
    if (normalizedX < 0 || normalizedX > 1) return;

    // Find closest data point
    let closest = dataPoints[0];
    let minDist = Math.abs(closest.x - normalizedX);
    for (const p of dataPoints) {
      const dist = Math.abs(p.x - normalizedX);
      if (dist < minDist) {
        minDist = dist;
        closest = p;
      }
    }
    onScrollToIndex(closest.eventIndex);
  };

  return (
    <div className="border-b px-4 py-2 shrink-0">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] font-medium text-muted-foreground">
          Context Usage
        </span>
        <span className="text-[10px] text-muted-foreground">
          ({dataPoints.length} data points)
        </span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${chartWidth} ${CHART_HEIGHT}`}
        className="w-full cursor-crosshair"
        style={{ maxHeight: CHART_HEIGHT }}
        onClick={handleClick}
      >
        {/* Danger zone background */}
        <rect
          x={CHART_PADDING_X}
          y={CHART_PADDING_TOP}
          width={innerWidth}
          height={dangerY - CHART_PADDING_TOP}
          className="fill-red-500/5"
        />

        {/* 80% threshold line */}
        <line
          x1={CHART_PADDING_X}
          y1={dangerY}
          x2={CHART_PADDING_X + innerWidth}
          y2={dangerY}
          className="stroke-red-500/30"
          strokeDasharray="4 3"
          strokeWidth={0.5}
        />

        {/* 50% line */}
        <line
          x1={CHART_PADDING_X}
          y1={toSvgY(0.5)}
          x2={CHART_PADDING_X + innerWidth}
          y2={toSvgY(0.5)}
          className="stroke-border"
          strokeDasharray="2 3"
          strokeWidth={0.3}
        />

        {/* Area fill */}
        <path d={areaPath} className="fill-primary/10" />

        {/* Line */}
        <path
          d={linePath}
          className="stroke-primary"
          strokeWidth={1.5}
          fill="none"
        />

        {/* Compaction markers */}
        {compactions.map((c) => (
          <line
            key={c.eventIndex}
            x1={toSvgX(c.x)}
            y1={CHART_PADDING_TOP}
            x2={toSvgX(c.x)}
            y2={CHART_HEIGHT - CHART_PADDING_BOTTOM}
            className="stroke-orange-500"
            strokeWidth={1.5}
            strokeDasharray="3 2"
          />
        ))}

        {/* Y-axis labels */}
        <text
          x={CHART_PADDING_X - 4}
          y={CHART_PADDING_TOP + 4}
          className="fill-muted-foreground"
          fontSize={8}
          textAnchor="end"
        >
          100%
        </text>
        <text
          x={CHART_PADDING_X - 4}
          y={dangerY + 3}
          className="fill-red-500/60"
          fontSize={8}
          textAnchor="end"
        >
          80%
        </text>
        <text
          x={CHART_PADDING_X - 4}
          y={toSvgY(0) + 3}
          className="fill-muted-foreground"
          fontSize={8}
          textAnchor="end"
        >
          0%
        </text>

        {/* Data point dots on hover via CSS - show all small dots */}
        {dataPoints.map((p) => (
          <circle
            key={p.eventIndex}
            cx={toSvgX(p.x)}
            cy={toSvgY(p.contextUsage)}
            r={1.5}
            className={`${p.contextUsage > 0.8 ? "fill-red-500" : "fill-primary"} opacity-40 hover:opacity-100 hover:r-3`}
          />
        ))}
      </svg>
    </div>
  );
}
