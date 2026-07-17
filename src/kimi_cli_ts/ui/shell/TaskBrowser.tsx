/**
 * TaskBrowser.tsx — Background task browser with React Ink.
 * Corresponds to Python's ui/shell/task_browser.py.
 *
 * Features:
 * - Background task list
 * - Detail/preview panel
 * - Stop/confirm operations
 * - Filter (all/active)
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";

// ── Types ───────────────────────────────────────────────

export type TaskStatus =
	| "running"
	| "starting"
	| "completed"
	| "failed"
	| "killed"
	| "lost";

export type TaskBrowserFilter = "all" | "active";

export interface TaskViewSpec {
	id: string;
	description: string;
	kind: string;
	command?: string;
	cwd?: string;
	createdAt: number;
}

export interface TaskViewRuntime {
	status: TaskStatus;
	exitCode?: number | null;
	failureReason?: string;
	startedAt?: number | null;
	finishedAt?: number | null;
	updatedAt: number;
	timedOut?: boolean;
}

export interface TaskView {
	spec: TaskViewSpec;
	runtime: TaskViewRuntime;
}

export interface TaskBrowserProps {
	tasks: TaskView[];
	onStop?: (taskId: string) => void;
	onViewOutput?: (taskId: string) => void;
	onRefresh?: () => void;
	onClose?: () => void;
}

const TERMINAL_STATUSES = new Set<TaskStatus>([
	"completed",
	"failed",
	"killed",
	"lost",
]);

function isTerminal(status: TaskStatus): boolean {
	return TERMINAL_STATUSES.has(status);
}

// ── Helpers ─────────────────────────────────────────────

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	return m > 0 ? `${h}h${m}m` : `${h}h`;
}

function formatRelativeTime(ts: number): string {
	const delta = Math.max(0, Math.floor(Date.now() / 1000 - ts));
	if (delta < 5) return "just now";
	if (delta < 60) return `${delta}s ago`;
	if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
	return `${Math.floor(delta / 3600)}h ago`;
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

// ── TaskBrowser ─────────────────────────────────────────

export function TaskBrowser({
	tasks,
	onStop,
	onViewOutput,
	onRefresh,
	onClose,
}: TaskBrowserProps) {
	const [filterMode, setFilterMode] = useState<TaskBrowserFilter>("all");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [pendingStopId, setPendingStopId] = useState<string | null>(null);
	const [flashMessage, setFlashMessage] = useState<string>("");

	// Filter tasks
	const visibleTasks =
		filterMode === "active"
			? tasks.filter((t) => !isTerminal(t.runtime.status))
			: [...tasks];

	// Sort: active first, then by created time
	visibleTasks.sort((a, b) => {
		const aTerminal = isTerminal(a.runtime.status) ? 1 : 0;
		const bTerminal = isTerminal(b.runtime.status) ? 1 : 0;
		if (aTerminal !== bTerminal) return aTerminal - bTerminal;
		return a.spec.createdAt - b.spec.createdAt;
	});

	const clampedIndex = Math.min(
		selectedIndex,
		Math.max(0, visibleTasks.length - 1),
	);
	const selectedTask = visibleTasks[clampedIndex] || null;

	// Status counts
	const counts: Record<string, number> = {
		running: 0,
		starting: 0,
		completed: 0,
		failed: 0,
		killed: 0,
		lost: 0,
	};
	for (const t of tasks) {
		counts[t.runtime.status] = (counts[t.runtime.status] || 0) + 1;
	}

	const flash = useCallback((msg: string) => {
		setFlashMessage(msg);
		setTimeout(() => setFlashMessage(""), 3000);
	}, []);

	useInput((input, key) => {
		// Confirm stop mode
		if (pendingStopId !== null) {
			if (input === "y" || input === "Y") {
				onStop?.(pendingStopId);
				flash(`Stop requested for task ${pendingStopId}.`);
				setPendingStopId(null);
				return;
			}
			if (input === "n" || input === "N" || key.escape) {
				flash("Stop cancelled.");
				setPendingStopId(null);
				return;
			}
			return;
		}

		// Normal mode
		if (key.upArrow) {
			setSelectedIndex((i) => Math.max(0, i - 1));
		} else if (key.downArrow) {
			setSelectedIndex((i) => Math.min(visibleTasks.length - 1, i + 1));
		} else if (input === "q" || key.escape) {
			onClose?.();
		} else if (key.tab) {
			const newFilter = filterMode === "all" ? "active" : "all";
			setFilterMode(newFilter);
			flash(
				newFilter === "active"
					? "Showing active tasks only."
					: "Showing all tasks.",
			);
		} else if (input === "r" || input === "R") {
			onRefresh?.();
			flash("Refreshed.");
		} else if (input === "s" || input === "S") {
			if (selectedTask) {
				if (isTerminal(selectedTask.runtime.status)) {
					flash(
						`Task ${selectedTask.spec.id} is already ${selectedTask.runtime.status}.`,
					);
				} else {
					setPendingStopId(selectedTask.spec.id);
				}
			}
		} else if (key.return || input === "o") {
			if (selectedTask) {
				onViewOutput?.(selectedTask.spec.id);
			}
		}
	});

	return (
		<Box flexDirection="column">
			{/* Header */}
			<Box>
				<Text backgroundColor="#1f2937" color="#67e8f9" bold>
					{" "}
					TASK BROWSER{" "}
				</Text>
				<Text backgroundColor="#1f2937" color="#9ca3af">
					{" "}
					filter={filterMode.toUpperCase()}{" "}
				</Text>
				<Text backgroundColor="#1f2937" color="#86efac" bold>
					{" "}
					{counts.running} running{" "}
				</Text>
				<Text backgroundColor="#1f2937" color="#93c5fd">
					{" "}
					{counts.starting} starting{" "}
				</Text>
				<Text backgroundColor="#1f2937" color="#fca5a5">
					{" "}
					{counts.failed} failed{" "}
				</Text>
				<Text backgroundColor="#1f2937" color="#86efac">
					{" "}
					{counts.completed} completed{" "}
				</Text>
				<Text backgroundColor="#1f2937" color="#fbbf24">
					{" "}
					{(counts.killed || 0) + (counts.lost || 0)} interrupted{" "}
				</Text>
				<Text backgroundColor="#1f2937" color="#9ca3af">
					{" "}
					{tasks.length} total{" "}
				</Text>
			</Box>

			<Box flexDirection="row" marginTop={1}>
				{/* Task list */}
				<Box
					flexDirection="column"
					width="50%"
					borderStyle="single"
					borderColor="#155e75"
					paddingX={1}
				>
					<Text color="#67e8f9" bold>
						Tasks [{filterMode}]
					</Text>
					{visibleTasks.length === 0 ? (
						<Text color="grey">
							{filterMode === "active"
								? "No active background tasks."
								: "No background tasks in this session."}
						</Text>
					) : (
						visibleTasks.map((task, idx) => {
							const isSelected = idx === clampedIndex;
							const description =
								task.spec.description.trim() || "(no description)";
							const timing = taskTimingLabel(task);
							const line = `[${task.runtime.status}] ${description} · ${task.spec.id} · ${task.spec.kind} · ${timing}`;
							return (
								<Text
									key={task.spec.id}
									color={isSelected ? "#ecfeff" : "#d1d5db"}
									backgroundColor={isSelected ? "#164e63" : undefined}
									bold={isSelected}
								>
									{isSelected ? ">" : " "} {line}
								</Text>
							);
						})
					)}
				</Box>

				{/* Detail + Preview */}
				<Box flexDirection="column" width="50%">
					<Box
						flexDirection="column"
						borderStyle="single"
						borderColor="#155e75"
						paddingX={1}
					>
						<Text color="#67e8f9" bold>
							Detail
						</Text>
						{selectedTask ? (
							<Box flexDirection="column">
								<Text>Task ID: {selectedTask.spec.id}</Text>
								<Text>Status: {selectedTask.runtime.status}</Text>
								<Text>Description: {selectedTask.spec.description}</Text>
								<Text>Kind: {selectedTask.spec.kind}</Text>
								<Text>Time: {taskTimingLabel(selectedTask)}</Text>
								{selectedTask.spec.cwd && (
									<Text>Cwd: {selectedTask.spec.cwd}</Text>
								)}
								{selectedTask.spec.command && (
									<Text>Command: {selectedTask.spec.command}</Text>
								)}
								{selectedTask.runtime.exitCode != null && (
									<Text>Exit code: {selectedTask.runtime.exitCode}</Text>
								)}
								{selectedTask.runtime.failureReason && (
									<Text>Reason: {selectedTask.runtime.failureReason}</Text>
								)}
							</Box>
						) : (
							<Text color="grey">Select a task from the list.</Text>
						)}
					</Box>
					<Box
						flexDirection="column"
						borderStyle="single"
						borderColor="#155e75"
						paddingX={1}
					>
						<Text color="#67e8f9" bold>
							Preview Output
						</Text>
						<Text color="grey">
							{selectedTask
								? "Press Enter or O to view full output."
								: "No output to preview."}
						</Text>
					</Box>
				</Box>
			</Box>

			{/* Footer */}
			<Box>
				{pendingStopId !== null ? (
					<>
						<Text color="red" bold>
							{" "}
							Confirm stop {pendingStopId}?{" "}
						</Text>
						<Text color="#67e8f9" bold>
							Y
						</Text>
						<Text> confirm </Text>
						<Text color="#67e8f9" bold>
							N
						</Text>
						<Text> cancel </Text>
					</>
				) : (
					<>
						<Text color="#67e8f9" bold>
							{" "}
							Enter{" "}
						</Text>
						<Text>output </Text>
						<Text color="#67e8f9" bold>
							S
						</Text>
						<Text> stop </Text>
						<Text color="#67e8f9" bold>
							R
						</Text>
						<Text> refresh </Text>
						<Text color="#67e8f9" bold>
							Tab
						</Text>
						<Text> filter </Text>
						<Text color="#67e8f9" bold>
							Q
						</Text>
						<Text> exit </Text>
						{flashMessage && <Text color="#94a3b8"> | {flashMessage}</Text>}
					</>
				)}
			</Box>
		</Box>
	);
}

export default TaskBrowser;
