import { useEffect, useState } from "react";
import { type AggregateStats, getAggregateStats } from "@/lib/api";

/* ------------------------------------------------------------------ */
/*  Formatting helpers                                                 */
/* ------------------------------------------------------------------ */

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec.toFixed(0)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)}min`;
  return `${(sec / 3600).toFixed(1)}h`;
}

/* ------------------------------------------------------------------ */
/*  Summary Cards                                                      */
/* ------------------------------------------------------------------ */

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-4 flex flex-col gap-1">
      <span className="text-2xl font-bold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Daily Usage Chart (SVG line chart)                                 */
/* ------------------------------------------------------------------ */

const CHART_WIDTH = 600;
const CHART_HEIGHT = 120;
const CHART_PAD_X = 40;
const CHART_PAD_TOP = 12;
const CHART_PAD_BOTTOM = 24;

function DailyUsageChart({
  daily,
}: {
  daily: AggregateStats["daily_usage"];
}) {
  if (daily.length === 0) return null;

  const maxSessions = Math.max(1, ...daily.map((d) => d.sessions));
  const maxTurns = Math.max(1, ...daily.map((d) => d.turns));

  const innerW = CHART_WIDTH - CHART_PAD_X * 2;
  const innerH = CHART_HEIGHT - CHART_PAD_TOP - CHART_PAD_BOTTOM;

  const toX = (i: number) =>
    CHART_PAD_X + (daily.length > 1 ? (i / (daily.length - 1)) * innerW : innerW / 2);
  const toYSessions = (v: number) =>
    CHART_PAD_TOP + (1 - v / maxSessions) * innerH;
  const toYTurns = (v: number) =>
    CHART_PAD_TOP + (1 - v / maxTurns) * innerH;

  // Sessions line
  const sessionsPath = daily
    .map((d, i) => `${i === 0 ? "M" : "L"} ${toX(i)} ${toYSessions(d.sessions)}`)
    .join(" ");

  // Turns line
  const turnsPath = daily
    .map((d, i) => `${i === 0 ? "M" : "L"} ${toX(i)} ${toYTurns(d.turns)}`)
    .join(" ");

  // Sessions area fill
  const sessionsArea =
    sessionsPath +
    ` L ${toX(daily.length - 1)} ${toYSessions(0)}` +
    ` L ${toX(0)} ${toYSessions(0)} Z`;

  // X-axis labels: show ~5 evenly spaced dates
  const labelCount = Math.min(5, daily.length);
  const labelIndices: number[] = [];
  if (labelCount <= 1) {
    if (daily.length > 0) labelIndices.push(0);
  } else {
    for (let i = 0; i < labelCount; i++) {
      labelIndices.push(
        Math.round((i / (labelCount - 1)) * (daily.length - 1)),
      );
    }
  }

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-medium">Daily Usage (Last 30 Days)</span>
      </div>

      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="w-full"
        style={{ maxHeight: CHART_HEIGHT }}
      >
        {/* Sessions area fill */}
        <path d={sessionsArea} className="fill-blue-500/10" />

        {/* Sessions line */}
        <path
          d={sessionsPath}
          className="stroke-blue-500"
          strokeWidth={1.5}
          fill="none"
        />

        {/* Turns line */}
        <path
          d={turnsPath}
          className="stroke-green-500"
          strokeWidth={1.5}
          fill="none"
          strokeDasharray="4 2"
        />

        {/* Y-axis labels */}
        <text
          x={CHART_PAD_X - 4}
          y={CHART_PAD_TOP + 4}
          className="fill-muted-foreground"
          fontSize={8}
          textAnchor="end"
        >
          {maxSessions}
        </text>
        <text
          x={CHART_PAD_X - 4}
          y={CHART_PAD_TOP + innerH + 3}
          className="fill-muted-foreground"
          fontSize={8}
          textAnchor="end"
        >
          0
        </text>

        {/* X-axis date labels */}
        {labelIndices.map((idx) => (
          <text
            key={idx}
            x={toX(idx)}
            y={CHART_HEIGHT - 4}
            className="fill-muted-foreground"
            fontSize={8}
            textAnchor="middle"
          >
            {daily[idx].date.slice(5)}
          </text>
        ))}

        {/* Data dots for sessions */}
        {daily.map((d, i) =>
          d.sessions > 0 ? (
            <circle
              key={i}
              cx={toX(i)}
              cy={toYSessions(d.sessions)}
              r={2}
              className="fill-blue-500"
            />
          ) : null,
        )}
      </svg>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-2">
        <div className="flex items-center gap-1">
          <div className="w-3 h-0.5 bg-blue-500 rounded" />
          <span className="text-[10px] text-muted-foreground">Sessions</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-0.5 bg-green-500 rounded border-dashed" />
          <span className="text-[10px] text-muted-foreground">Turns</span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tool Usage Bar Chart                                               */
/* ------------------------------------------------------------------ */

function ToolUsageChart({
  tools,
}: {
  tools: AggregateStats["tool_usage"];
}) {
  if (tools.length === 0) return null;

  const maxCount = tools[0].count;

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-medium">Tool Usage (Top 20)</span>
      </div>

      <div className="flex flex-col gap-1">
        {tools.map((tool) => {
          const barPct = maxCount > 0 ? (tool.count / maxCount) * 100 : 0;
          const errorPct =
            tool.count > 0 ? (tool.error_count / tool.count) * 100 : 0;
          const successPct = 100 - errorPct;

          return (
            <div key={tool.name} className="flex items-center gap-2">
              <div className="w-[140px] shrink-0 text-right pr-1">
                <span className="text-[11px] text-foreground truncate">
                  {tool.name}
                </span>
              </div>

              <div className="flex-1 h-3 bg-muted/30 rounded-sm overflow-hidden">
                <div
                  className="h-full flex rounded-sm"
                  style={{ width: `${barPct}%` }}
                >
                  <div
                    className="h-full bg-blue-500/70"
                    style={{ width: `${successPct}%` }}
                  />
                  {tool.error_count > 0 && (
                    <div
                      className="h-full bg-red-500/70"
                      style={{ width: `${errorPct}%` }}
                    />
                  )}
                </div>
              </div>

              <span className="w-[64px] shrink-0 text-[10px] text-muted-foreground text-right tabular-nums">
                {tool.count}
                {tool.error_count > 0 && (
                  <span className="text-red-500 ml-1">
                    ({tool.error_count})
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 mt-2">
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-sm bg-blue-500/70" />
          <span className="text-[10px] text-muted-foreground">Success</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-sm bg-red-500/70" />
          <span className="text-[10px] text-muted-foreground">Error</span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Per-Project Table                                                  */
/* ------------------------------------------------------------------ */

function ProjectTable({
  projects,
}: {
  projects: AggregateStats["per_project"];
}) {
  if (projects.length === 0) return null;

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-medium">Top Projects</span>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            <th className="text-left py-1.5 font-medium">Project</th>
            <th className="text-right py-1.5 font-medium w-[80px]">Sessions</th>
            <th className="text-right py-1.5 font-medium w-[80px]">Turns</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => {
            const segments = p.work_dir.split("/");
            const shortName = segments[segments.length - 1] || p.work_dir;
            return (
              <tr key={p.work_dir} className="border-b last:border-b-0">
                <td
                  className="py-1.5 truncate max-w-[300px]"
                  title={p.work_dir}
                >
                  {shortName}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {p.sessions}
                </td>
                <td className="py-1.5 text-right tabular-nums">{p.turns}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main StatisticsView                                                */
/* ------------------------------------------------------------------ */

export function StatisticsView() {
  const [stats, setStats] = useState<AggregateStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getAggregateStats()
      .then(setStats)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Skeleton cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="rounded-lg border p-4 space-y-2">
              <div className="h-7 w-20 rounded bg-muted animate-pulse" />
              <div className="h-3 w-16 rounded bg-muted animate-pulse" />
            </div>
          ))}
        </div>
        <div className="h-[160px] rounded-lg border bg-muted/30 animate-pulse" />
        <div className="h-[200px] rounded-lg border bg-muted/30 animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-500 text-sm">
        Failed to load statistics: {error}
      </div>
    );
  }

  if (!stats) return null;

  const totalTokens = stats.total_tokens.input + stats.total_tokens.output;

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label="Total Sessions" value={String(stats.total_sessions)} />
        <SummaryCard label="Total Turns" value={String(stats.total_turns)} />
        <SummaryCard
          label="Total Tokens"
          value={formatTokens(totalTokens)}
        />
        <SummaryCard
          label="Total Duration"
          value={formatDuration(stats.total_duration_sec)}
        />
      </div>

      {/* Token detail */}
      <div className="text-xs text-muted-foreground px-1">
        Tokens: {formatTokens(stats.total_tokens.input)} input / {formatTokens(stats.total_tokens.output)} output
      </div>

      {/* Daily Usage Chart */}
      <DailyUsageChart daily={stats.daily_usage} />

      {/* Tool Usage + Project Table side by side on wide screens */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ToolUsageChart tools={stats.tool_usage} />
        <ProjectTable projects={stats.per_project} />
      </div>
    </div>
  );
}
