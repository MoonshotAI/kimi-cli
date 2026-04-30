/**
 * TaskPanel.tsx — Background task browser panel.
 *
 * Displays background tasks in a list with status, ID, description, and timing.
 * Supports keyboard navigation: up/down to select, Enter to view output,
 * 's' to stop, Tab to toggle filter, 'r' to refresh, Esc to close.
 *
 * Uses PanelShell for borders and usePanelKeyboard for input capture.
 * Corresponds to Python's ui/shell/task_browser.py.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text } from "ink";
import { PanelShell } from "../components/PanelShell.tsx";
import { usePanelScroller } from "../hooks/usePanelScroller.ts";
import { useInputLayer } from "./input-stack.ts";
import type { InputKey } from "./input-stack.ts";
import { getBackgroundManager } from "../../tools/background/index.ts";
import type { TaskView, TaskStatus } from "../../background/models.ts";
import { isTerminalStatus } from "../../background/models.ts";

// ── Constants ──────────────────────────────────────────

const AUTO_REFRESH_MS = 1000;
const FLASH_DURATION_MS = 3000;
const PREVIEW_MAX_LINES = 6;
const PREVIEW_MAX_BYTES = 4000;
const FULL_OUTPUT_MAX_LINES = 200;
const FULL_OUTPUT_MAX_BYTES = 200_000;

const DIM = "#888888";
const HIGHLIGHT = "#1e90ff";
const GREEN = "#00cc00";
const RED = "#ff4444";
const YELLOW = "#cccc00";
const CYAN = "cyan";

type FilterMode = "all" | "active";
type ViewMode = "list" | "detail";

// ── Status icon helpers ────────────────────────────────

function statusIcon(status: TaskStatus): string {
	switch (status) {
		case "running":
			return "\u25B6"; // ▶
		case "starting":
			return "\u25CB"; // ○
		case "awaiting_approval":
			return "\u25CF"; // ●
		case "completed":
			return "\u2714"; // ✔
		case "failed":
			return "\u2718"; // ✘
		case "killed":
			return "\u25A0"; // ■
		case "lost":
			return "?";
		default:
			return "\u00B7"; // ·
	}
}

function statusColor(status: TaskStatus): string {
	switch (status) {
		case "running":
		case "starting":
			return CYAN;
		case "completed":
			return GREEN;
		case "failed":
			return RED;
		case "killed":
		case "lost":
			return YELLOW;
		case "awaiting_approval":
			return YELLOW;
		default:
			return DIM;
	}
}

// ── Timing helpers ─────────────────────────────────────

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	return `${h}h ${m}m`;
}

function formatRelativeTime(timestamp: number): string {
	const delta = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
	if (delta < 5) return "just now";
	if (delta < 60) return `${delta}s ago`;
	if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
	if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
	return `${Math.floor(delta / 86400)}d ago`;
}

function taskTimingLabel(view: TaskView): string {
	const now = Date.now() / 1000;
	if (view.runtime.finishedAt != null) {
		return `finished ${formatRelativeTime(view.runtime.finishedAt)}`;
	}
	if (view.runtime.startedAt != null) {
		const seconds = Math.max(0, Math.floor(now - view.runtime.startedAt));
		return `running ${formatDuration(seconds)}`;
	}
	return `updated ${formatRelativeTime(view.runtime.updatedAt)}`;
}

// ── Sort helper (matches Python's _task_sort_key) ──────

function taskSortKey(view: TaskView): [number, number] {
	if (!isTerminalStatus(view.runtime.status)) {
		return [0, view.spec.createdAt];
	}
	const finishedAt =
		view.runtime.finishedAt ?? view.runtime.updatedAt ?? view.spec.createdAt;
	return [1, -finishedAt];
}

function compareTasks(a: TaskView, b: TaskView): number {
	const ka = taskSortKey(a);
	const kb = taskSortKey(b);
	if (ka[0] !== kb[0]) return ka[0] - kb[0];
	return ka[1] - kb[1];
}

// ── Props ──────────────────────────────────────────────

export interface TaskPanelProps {
	onClose: () => void;
}

// ── Component ──────────────────────────────────────────

export function TaskPanel({ onClose }: TaskPanelProps) {
	const [tasks, setTasks] = useState<TaskView[]>([]);
	const [filterMode, setFilterMode] = useState<FilterMode>("all");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [viewMode, setViewMode] = useState<ViewMode>("list");
	const [flashMessage, setFlashMessage] = useState<string | null>(null);
	const [pendingStopId, setPendingStopId] = useState<string | null>(null);
	const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// ── Flash message helper ──
	const showFlash = useCallback((msg: string) => {
		setFlashMessage(msg);
		if (flashTimer.current) clearTimeout(flashTimer.current);
		flashTimer.current = setTimeout(
			() => setFlashMessage(null),
			FLASH_DURATION_MS,
		);
	}, []);

	// ── Refresh tasks ──
	const refreshTasks = useCallback(() => {
		const manager = getBackgroundManager();
		if (!manager) {
			setTasks([]);
			return;
		}
		manager.reconcile();
		let views = manager.listTasks({ limit: undefined });
		views.sort(compareTasks);
		setTasks(views);
	}, []);

	// ── Filtered view ──
	const visibleTasks =
		filterMode === "active"
			? tasks.filter((v) => !isTerminalStatus(v.runtime.status))
			: tasks;

	// ── Auto-refresh on interval ──
	useEffect(() => {
		refreshTasks();
		const interval = setInterval(refreshTasks, AUTO_REFRESH_MS);
		return () => clearInterval(interval);
	}, [refreshTasks]);

	// ── Clamp selected index ──
	useEffect(() => {
		if (selectedIndex >= visibleTasks.length) {
			setSelectedIndex(Math.max(0, visibleTasks.length - 1));
		}
	}, [visibleTasks.length, selectedIndex]);

	const selectedTask =
		visibleTasks.length > 0 ? visibleTasks[selectedIndex] : null;

	// ── Get full output for detail view ──
	const getFullOutput = useCallback(
		(taskId: string): string => {
			const manager = getBackgroundManager();
			if (!manager) return "[no output available]";
			try {
				const output = manager.tailOutput(taskId, {
					maxBytes: FULL_OUTPUT_MAX_BYTES,
					maxLines: FULL_OUTPUT_MAX_LINES,
				});
				return output || "[no output available]";
			} catch {
				return "[no output available]";
			}
		},
		[],
	);

	// ── Get preview output ──
	const getPreview = useCallback((taskId: string): string => {
		const manager = getBackgroundManager();
		if (!manager) return "[no output available]";
		try {
			const output = manager.tailOutput(taskId, {
				maxBytes: PREVIEW_MAX_BYTES,
				maxLines: PREVIEW_MAX_LINES,
			});
			return output || "[no output]";
		} catch {
			return "[no output]";
		}
	}, []);

	// ── Keyboard input ──
	useInputLayer((input: string, key: InputKey) => {
		// Stop confirmation mode
		if (pendingStopId !== null) {
			if (input === "y" || input === "Y") {
				const manager = getBackgroundManager();
				if (manager) {
					try {
						manager.kill(pendingStopId);
						showFlash(`Stop requested for ${pendingStopId}`);
					} catch (err: any) {
						showFlash(`Error: ${err.message ?? String(err)}`);
					}
				}
				setPendingStopId(null);
				refreshTasks();
				return;
			}
			if (
				input === "n" ||
				input === "N" ||
				key.escape
			) {
				setPendingStopId(null);
				showFlash("Stop cancelled.");
				return;
			}
			return; // consume all other keys while confirming
		}

		// Detail view
		if (viewMode === "detail") {
			if (key.escape || input === "q") {
				setViewMode("list");
				return;
			}
			return; // consume all keys in detail view
		}

		// List view
		if (key.escape || input === "q") {
			onClose();
			return;
		}

		if (key.upArrow) {
			setSelectedIndex((i) => Math.max(0, i - 1));
			return;
		}
		if (key.downArrow) {
			setSelectedIndex((i) => Math.min(visibleTasks.length - 1, i + 1));
			return;
		}

		if (key.return) {
			if (selectedTask) {
				setViewMode("detail");
			}
			return;
		}

		if (input === "s" || input === "S") {
			if (!selectedTask) {
				showFlash("No task selected.");
				return;
			}
			if (isTerminalStatus(selectedTask.runtime.status)) {
				showFlash(
					`Task ${selectedTask.spec.id} is already ${selectedTask.runtime.status}.`,
				);
				return;
			}
			setPendingStopId(selectedTask.spec.id);
			return;
		}

		if (input === "r" || input === "R") {
			refreshTasks();
			showFlash("Refreshed.");
			return;
		}

		if (key.tab) {
			const next = filterMode === "all" ? "active" : "all";
			setFilterMode(next);
			showFlash(
				next === "active"
					? "Showing active tasks only."
					: "Showing all tasks.",
			);
			return;
		}
	});

	// ── Scroller ──
	const scroller = usePanelScroller({
		totalItems: visibleTasks.length,
		focusedIndex: selectedIndex,
		minVisible: 3,
		terminalReservedLines: 10,
	});

	// ── Summary counts ──
	const counts = {
		running: 0,
		starting: 0,
		completed: 0,
		failed: 0,
		killed: 0,
		lost: 0,
	};
	for (const t of tasks) {
		const s = t.runtime.status;
		if (s in counts) counts[s as keyof typeof counts]++;
	}

	// ── Detail view ──
	if (viewMode === "detail" && selectedTask) {
		const output = getFullOutput(selectedTask.spec.id);
		const lines = output.split("\n");
		const terminalReason = selectedTask.runtime.timedOut
			? "timed_out"
			: selectedTask.runtime.status;

		return (
			<PanelShell
				variant="rules"
				title={`Task: ${selectedTask.spec.id}`}
				titleColor={HIGHLIGHT}
				footerHints={["Esc back"]}
			>
				<Box flexDirection="column" paddingX={1}>
					<Text>
						<Text color={CYAN}>Status: </Text>
						<Text color={statusColor(selectedTask.runtime.status)}>
							{selectedTask.runtime.status}
						</Text>
					</Text>
					<Text>
						<Text color={CYAN}>Description: </Text>
						<Text>{selectedTask.spec.description || "(no description)"}</Text>
					</Text>
					<Text>
						<Text color={CYAN}>Kind: </Text>
						<Text>{selectedTask.spec.kind}</Text>
					</Text>
					<Text>
						<Text color={CYAN}>Time: </Text>
						<Text>{taskTimingLabel(selectedTask)}</Text>
					</Text>
					{selectedTask.spec.cwd && (
						<Text>
							<Text color={CYAN}>Cwd: </Text>
							<Text>{selectedTask.spec.cwd}</Text>
						</Text>
					)}
					{selectedTask.spec.command && (
						<Text>
							<Text color={CYAN}>Command: </Text>
							<Text>{selectedTask.spec.command}</Text>
						</Text>
					)}
					{selectedTask.runtime.exitCode != null && (
						<Text>
							<Text color={CYAN}>Exit code: </Text>
							<Text>{selectedTask.runtime.exitCode}</Text>
						</Text>
					)}
					<Text>
						<Text color={CYAN}>Terminal reason: </Text>
						<Text>{terminalReason}</Text>
					</Text>
					{selectedTask.runtime.failureReason && (
						<Text>
							<Text color={CYAN}>Reason: </Text>
							<Text color={RED}>{selectedTask.runtime.failureReason}</Text>
						</Text>
					)}
					<Text> </Text>
					<Text bold color={CYAN}>
						Output:
					</Text>
					{lines.slice(0, FULL_OUTPUT_MAX_LINES).map((line, i) => (
						<Text key={i}>{line || " "}</Text>
					))}
				</Box>
			</PanelShell>
		);
	}

	// ── List view ──

	// Footer content
	let footerHints: string[];
	if (pendingStopId) {
		footerHints = [`Confirm stop ${pendingStopId}? Y/N`];
	} else {
		footerHints = [
			"\u2191\u2193 select",
			"Enter output",
			"S stop",
			"R refresh",
			"Tab filter",
			"Esc close",
		];
	}

	const filterLabel = filterMode === "all" ? "ALL" : "ACTIVE";
	const summaryParts = [
		`filter=${filterLabel}`,
		`${counts.running} running`,
		`${counts.starting} starting`,
		`${counts.failed} failed`,
		`${counts.completed} completed`,
		`${counts.killed + counts.lost} interrupted`,
		`${tasks.length} total`,
	];

	if (visibleTasks.length === 0) {
		const emptyMsg =
			filterMode === "active"
				? "No active background tasks."
				: "No background tasks in this session.";
		return (
			<PanelShell
				variant="rules"
				title="Background Tasks"
				titleColor={HIGHLIGHT}
				footerHints={["Tab filter", "Esc close"]}
				footerLeft={summaryParts.join(" | ")}
			>
				<Box paddingX={1}>
					<Text color={DIM}>{emptyMsg}</Text>
				</Box>
			</PanelShell>
		);
	}

	return (
		<PanelShell
			variant="rules"
			title="Background Tasks"
			titleColor={HIGHLIGHT}
			footerHints={footerHints}
			footerLeft={
				flashMessage
					? flashMessage
					: `${summaryParts.join(" | ")}`
			}
		>
			{scroller.hasAbove && <Text color={DIM}> \u2191 more...</Text>}
			{visibleTasks
				.slice(scroller.startIndex, scroller.endIndex)
				.map((view, vi) => {
					const i = scroller.startIndex + vi;
					const isSelected = i === selectedIndex;
					const desc =
						view.spec.description.trim() || "(no description)";
					const timing = taskTimingLabel(view);
					const icon = statusIcon(view.runtime.status);
					const color = statusColor(view.runtime.status);
					const preview = isSelected ? getPreview(view.spec.id) : null;

					return (
						<Box key={view.spec.id} flexDirection="column">
							<Box paddingX={1}>
								<Text color={isSelected ? HIGHLIGHT : DIM}>
									{isSelected ? "\u25B8 " : "  "}
								</Text>
								<Text color={color}>{icon} </Text>
								<Text
									bold={isSelected}
									color={isSelected ? HIGHLIGHT : undefined}
								>
									[{view.runtime.status}]
								</Text>
								<Text color={DIM}> \u00B7 </Text>
								<Text bold={isSelected}>{desc}</Text>
								<Text color={DIM}>
									{" "}
									\u00B7 {view.spec.id} \u00B7 {view.spec.kind} \u00B7{" "}
									{timing}
								</Text>
							</Box>
							{isSelected && preview && (
								<Box paddingX={3} flexDirection="column">
									{preview
										.split("\n")
										.slice(0, PREVIEW_MAX_LINES)
										.map((line, li) => (
											<Text key={li} color={DIM}>
												{line}
											</Text>
										))}
								</Box>
							)}
						</Box>
					);
				})}
			{scroller.hasBelow && <Text color={DIM}> \u2193 more...</Text>}
		</PanelShell>
	);
}
