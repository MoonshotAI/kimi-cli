/**
 * UsagePanel.tsx — API usage and quota display panel.
 * Corresponds to Python's ui/shell/usage.py.
 *
 * Features:
 * - API quota usage display
 * - Progress bars
 * - Reset timer
 */

import React from "react";
import { Box, Text } from "ink";

export interface UsageRow {
  label: string;
  used: number;
  limit: number;
  resetHint?: string | null;
}

export interface UsagePanelProps {
  summary?: UsageRow | null;
  limits: UsageRow[];
  loading?: boolean;
  error?: string | null;
}

function ProgressBar({
  completed,
  total,
  width = 20,
}: {
  completed: number;
  total: number;
  width?: number;
}) {
  const ratio = total > 0 ? Math.min(completed / total, 1) : 0;
  const filledWidth = Math.round(ratio * width);
  const emptyWidth = width - filledWidth;
  const color = ratioColor(total > 0 ? (total - completed) / total : 0);

  return (
    <Text>
      <Text color={color}>{"█".repeat(filledWidth)}</Text>
      <Text color="grey">{"░".repeat(emptyWidth)}</Text>
    </Text>
  );
}

function ratioColor(ratio: number): string {
  if (ratio >= 0.9) return "red";
  if (ratio >= 0.7) return "yellow";
  return "green";
}

function UsageRowView({ row, labelWidth }: { row: UsageRow; labelWidth: number }) {
  const remaining = row.limit > 0 ? (row.limit - row.used) / row.limit : 0;
  const percent = remaining * 100;

  return (
    <Box>
      <Box width={labelWidth + 2}>
        <Text color="cyan">{row.label.padEnd(labelWidth)}</Text>
      </Box>
      <Box width={22}>
        <ProgressBar completed={row.used} total={row.limit || 1} width={20} />
      </Box>
      <Box>
        <Text bold>{`  ${percent.toFixed(0)}% left`}</Text>
        {row.resetHint && (
          <Text color="grey">{`  (${row.resetHint})`}</Text>
        )}
      </Box>
    </Box>
  );
}

export function UsagePanel({ summary, limits, loading, error }: UsagePanelProps) {
  if (loading) {
    return (
      <Box
        borderStyle="round"
        borderColor="#d2b48c"
        paddingX={2}
      >
        <Text color="cyan">Fetching usage...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box
        borderStyle="round"
        borderColor="#d2b48c"
        paddingX={2}
      >
        <Text color="red">{error}</Text>
      </Box>
    );
  }

  const rows = [...(summary ? [summary] : []), ...limits];
  if (rows.length === 0) {
    return (
      <Box
        borderStyle="round"
        borderColor="#d2b48c"
        paddingX={2}
      >
        <Text color="grey">No usage data</Text>
      </Box>
    );
  }

  const labelWidth = Math.max(6, ...rows.map((r) => r.label.length));

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="#d2b48c"
      paddingX={2}
    >
      <Text bold>API Usage</Text>
      <Text> </Text>
      {rows.map((row, idx) => (
        <UsageRowView key={idx} row={row} labelWidth={labelWidth} />
      ))}
    </Box>
  );
}

// ── Usage data parsing helpers ──────────────────────────

export function parseUsagePayload(payload: Record<string, unknown>): {
  summary: UsageRow | null;
  limits: UsageRow[];
} {
  let summary: UsageRow | null = null;
  const limits: UsageRow[] = [];

  const usage = payload.usage;
  if (usage && typeof usage === "object") {
    summary = toUsageRow(usage as Record<string, unknown>, "Weekly limit");
  }

  const rawLimits = payload.limits;
  if (Array.isArray(rawLimits)) {
    for (let idx = 0; idx < rawLimits.length; idx++) {
      const item = rawLimits[idx];
      if (!item || typeof item !== "object") continue;
      const itemMap = item as Record<string, unknown>;
      const detail =
        itemMap.detail && typeof itemMap.detail === "object"
          ? (itemMap.detail as Record<string, unknown>)
          : itemMap;
      const window =
        itemMap.window && typeof itemMap.window === "object"
          ? (itemMap.window as Record<string, unknown>)
          : {};
      const label = limitLabel(itemMap, detail, window, idx);
      const row = toUsageRow(detail, label);
      if (row) limits.push(row);
    }
  }

  return { summary, limits };
}

function toUsageRow(
  data: Record<string, unknown>,
  defaultLabel: string,
): UsageRow | null {
  const limit = toInt(data.limit);
  let used = toInt(data.used);
  if (used == null) {
    const remaining = toInt(data.remaining);
    if (remaining != null && limit != null) {
      used = limit - remaining;
    }
  }
  if (used == null && limit == null) return null;
  return {
    label: String(data.name || data.title || defaultLabel),
    used: used || 0,
    limit: limit || 0,
    resetHint: resetHint(data),
  };
}

function limitLabel(
  item: Record<string, unknown>,
  detail: Record<string, unknown>,
  window: Record<string, unknown>,
  idx: number,
): string {
  for (const key of ["name", "title", "scope"]) {
    const val = item[key] || detail[key];
    if (val) return String(val);
  }
  const duration = toInt(
    window.duration || item.duration || detail.duration,
  );
  const timeUnit = String(
    window.timeUnit || item.timeUnit || detail.timeUnit || "",
  );
  if (duration) {
    if (timeUnit.includes("MINUTE")) {
      if (duration >= 60 && duration % 60 === 0) return `${duration / 60}h limit`;
      return `${duration}m limit`;
    }
    if (timeUnit.includes("HOUR")) return `${duration}h limit`;
    if (timeUnit.includes("DAY")) return `${duration}d limit`;
    return `${duration}s limit`;
  }
  return `Limit #${idx + 1}`;
}

function resetHint(data: Record<string, unknown>): string | null {
  for (const key of ["reset_at", "resetAt", "reset_time", "resetTime"]) {
    if (data[key]) return formatResetTime(String(data[key]));
  }
  for (const key of ["reset_in", "resetIn", "ttl", "window"]) {
    const seconds = toInt(data[key]);
    if (seconds) return `resets in ${formatDuration(seconds)}`;
  }
  return null;
}

function formatResetTime(val: string): string {
  try {
    const dt = new Date(val);
    const now = Date.now();
    const delta = dt.getTime() - now;
    if (delta <= 0) return "reset";
    return `resets in ${formatDuration(Math.floor(delta / 1000))}`;
  } catch {
    return `resets at ${val}`;
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
}

function toInt(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

export default UsagePanel;
