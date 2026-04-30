/**
 * UsagePanel.tsx — API usage and quota display panel.
 * Matches Python's ui/shell/usage.py rendering character-for-character.
 *
 * Python uses Rich Panel(expand=False, border_style="wheat4", padding=(0,2))
 * with ProgressBar(width=20, complete_style=color) using ━╺╸ characters.
 *
 * Uses PanelShell for borders and usePanelKeyboard for Esc dismiss.
 */

import { Text } from "ink";
import type React from "react";
import { PanelRow, PanelShell } from "../components/PanelShell.tsx";
import { usePanelKeyboard } from "../hooks/usePanelKeyboard.ts";

const BAR_BG_COLOR = "#3a3a3a"; // Rich color 237
const HINT_COLOR = "#808080"; // Rich grey50 / color 244

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
	onClose?: () => void;
}

/**
 * Rich-style progress bar using ━╺╸ characters.
 * Exactly matches Python's rich.progress_bar.ProgressBar.__rich_console__.
 */
function RichProgressBar({
	completed,
	total,
	width = 20,
}: {
	completed: number;
	total: number;
	width?: number;
}) {
	const remainingRatio = total > 0 ? (total - completed) / total : 0;
	const color = ratioColor(remainingRatio);

	if (completed <= 0) {
		return <Text color={BAR_BG_COLOR}>{"\u2501".repeat(width)}</Text>;
	}
	if (completed >= total) {
		return <Text color={color}>{"\u2501".repeat(width)}</Text>;
	}

	const completeHalves = Math.floor((width * 2 * completed) / total);
	const barCount = Math.floor(completeHalves / 2);
	const halfBarCount = completeHalves % 2;

	const parts: React.ReactNode[] = [];

	if (barCount > 0) {
		parts.push(
			<Text key="filled" color={color}>
				{"\u2501".repeat(barCount)}
			</Text>,
		);
	}

	let remainingBars = width - barCount - halfBarCount;

	if (halfBarCount > 0) {
		parts.push(
			<Text key="half" color={color}>
				{"\u2578"}
			</Text>,
		);
	}

	if (remainingBars > 0) {
		if (halfBarCount === 0 && barCount > 0) {
			parts.push(
				<Text key="trans" color={BAR_BG_COLOR}>
					{"\u257A"}
				</Text>,
			);
			remainingBars -= 1;
		}
		if (remainingBars > 0) {
			parts.push(
				<Text key="empty" color={BAR_BG_COLOR}>
					{"\u2501".repeat(remainingBars)}
				</Text>,
			);
		}
	}

	return <Text>{parts}</Text>;
}

function ratioColor(ratio: number): string {
	if (ratio >= 0.9) return "red";
	if (ratio >= 0.7) return "yellow";
	return "green";
}

function UsageRowView({
	row,
	labelWidth,
	contentWidth,
}: {
	row: UsageRow;
	labelWidth: number;
	contentWidth: number;
}) {
	const remaining = row.limit > 0 ? (row.limit - row.used) / row.limit : 0;
	const percent = remaining * 100;

	const pctText = `  ${percent.toFixed(0)}% left`;
	const hintText = row.resetHint ? `  (${row.resetHint})` : "";
	const labelText = row.label.padEnd(labelWidth) + "  ";

	const usedWidth = labelText.length + 20 + pctText.length + hintText.length;
	const rightPad = Math.max(0, contentWidth - usedWidth);

	return (
		<Text>
			<Text color="cyan">{labelText}</Text>
			<RichProgressBar completed={row.used} total={row.limit || 1} width={20} />
			<Text bold>{pctText}</Text>
			{hintText && <Text color={HINT_COLOR}>{hintText}</Text>}
			{rightPad > 0 && <Text>{" ".repeat(rightPad)}</Text>}
		</Text>
	);
}

export function UsagePanel({
	summary,
	limits,
	loading,
	error,
	onClose,
}: UsagePanelProps) {
	// Keyboard: only Esc to close
	usePanelKeyboard({
		onEscape: () => onClose?.(),
	});

	if (loading) {
		const loadingText = "Fetching usage...";
		return (
			<PanelShell title="API Usage" contentWidth={loadingText.length}>
				<PanelRow contentWidth={loadingText.length}>
					<Text color="cyan">{loadingText}</Text>
				</PanelRow>
			</PanelShell>
		);
	}

	if (error) {
		return (
			<PanelShell title="API Usage" contentWidth={error.length}>
				<PanelRow contentWidth={error.length}>
					<Text color="red">{error}</Text>
				</PanelRow>
			</PanelShell>
		);
	}

	const rows = [...(summary ? [summary] : []), ...limits];
	if (rows.length === 0) {
		const noData = "No usage data";
		return (
			<PanelShell title="API Usage" contentWidth={noData.length}>
				<PanelRow contentWidth={noData.length}>
					<Text color="grey">{noData}</Text>
				</PanelRow>
			</PanelShell>
		);
	}

	const labelWidth = Math.max(6, ...rows.map((r) => r.label.length));

	const contentWidth = Math.max(
		...rows.map((row) => {
			const remaining = row.limit > 0 ? (row.limit - row.used) / row.limit : 0;
			const pctText = `  ${(remaining * 100).toFixed(0)}% left`;
			const hintText = row.resetHint ? `  (${row.resetHint})` : "";
			const labelText = row.label.padEnd(labelWidth) + "  ";
			return labelText.length + 20 + pctText.length + hintText.length;
		}),
	);

	return (
		<PanelShell
			title="API Usage"
			contentWidth={contentWidth}
			footerHints={["Esc close"]}
		>
			{rows.map((row, idx) => (
				<PanelRow key={idx} contentWidth={contentWidth}>
					<UsageRowView
						row={row}
						labelWidth={labelWidth}
						contentWidth={contentWidth}
					/>
				</PanelRow>
			))}
		</PanelShell>
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
	const duration = toInt(window.duration || item.duration || detail.duration);
	const timeUnit = String(
		window.timeUnit || item.timeUnit || detail.timeUnit || "",
	);
	if (duration) {
		if (timeUnit.includes("MINUTE")) {
			if (duration >= 60 && duration % 60 === 0)
				return `${duration / 60}h limit`;
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
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	if (days > 0) {
		const parts = [`${days}d`];
		if (hours > 0) parts.push(`${hours}h`);
		if (mins > 0) parts.push(`${mins}m`);
		return parts.join(" ");
	}
	return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function toInt(value: unknown): number | null {
	if (value == null) return null;
	const n = Number(value);
	return Number.isFinite(n) ? Math.floor(n) : null;
}

export default UsagePanel;
