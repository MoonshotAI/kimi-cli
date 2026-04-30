/**
 * StatusBar component — 3-line bottom toolbar matching Python's layout exactly.
 *
 * Layout:
 * ────────────────────────────────────────────────────────────────
 * [yolo] [plan] agent (model ●)  ~/cwd  main [± ↑1]  ⚙ bash:2  tip1 | tip2
 * [left toast]                                  context: 45.2% (12k/200k)
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useStdout } from "ink";
import type { StatusUpdate } from "../../wire/types.ts";
import type { Toast } from "./NotificationStack.tsx";

// Python 256-color palette mappings:
// - palette 239 = #4e4e4e (separator)
// - palette 240 = #585858 (tip text)
// - palette 241 = #626262 (cwd, dim text)
// - palette 244 = #808080 (grey50, bg_tasks)
const SEPARATOR_COLOR = "#4e4e4e"; // palette 239
const TIP_COLOR = "#585858"; // palette 240
const DIM = "#626262"; // palette 241 for cwd
const BG_TASKS_COLOR = "#808080"; // palette 244
const TIP_ROTATE_MS = 30_000;

const DEFAULT_TIPS = [
	"ctrl-x: toggle mode",
	"shift-tab: plan mode",
	"ctrl-o: editor",
	"ctrl-j: newline",
	"/feedback: send feedback",
	"/theme: switch dark/light",
	"@: mention files",
];

interface StatusBarProps {
	modelName?: string;
	workDir?: string;
	status: StatusUpdate | null;
	isStreaming: boolean;
	stepCount: number;
	isCompacting?: boolean;
	planMode?: boolean;
	yolo?: boolean;
	thinking?: boolean;
	shellMode?: boolean;
	// Git info
	gitBranch?: string | null;
	gitDirty?: boolean;
	gitAhead?: number;
	gitBehind?: number;
	// Background tasks
	bgTaskCount?: number;
	// Toast notifications (embedded in line 2)
	toasts?: Toast[];
	onDismissToast?: (id: string) => void;
	// Tips (rotatable)
	tips?: string[];
}

export function StatusBar({
	modelName = "",
	workDir,
	status,
	isStreaming,
	stepCount,
	isCompacting = false,
	planMode = false,
	yolo = false,
	thinking = false,
	shellMode = false,
	gitBranch,
	gitDirty = false,
	gitAhead = 0,
	gitBehind = 0,
	bgTaskCount = 0,
	toasts = [],
	onDismissToast,
	tips = DEFAULT_TIPS,
}: StatusBarProps) {
	const { stdout } = useStdout();
	const columns = stdout?.columns ?? 80;

	// Tip rotation
	const [tipIndex, setTipIndex] = useState(0);
	useEffect(() => {
		if (tips.length === 0) return;
		const timer = setInterval(() => {
			setTipIndex((i) => (i + 1) % tips.length);
		}, TIP_ROTATE_MS);
		return () => clearInterval(timer);
	}, [tips.length]);

	// Auto-dismiss toasts
	useEffect(() => {
		if (toasts.length === 0 || !onDismissToast) return;
		const timers: ReturnType<typeof setTimeout>[] = [];
		for (const toast of toasts) {
			const duration = toast.duration ?? 5000;
			if (duration > 0) {
				const elapsed = Date.now() - toast.createdAt;
				const remaining = Math.max(0, duration - elapsed);
				timers.push(setTimeout(() => onDismissToast(toast.id), remaining));
			}
		}
		return () => timers.forEach(clearTimeout);
	}, [toasts, onDismissToast]);

	// Context usage — match Python format: "context: 45.3% (28.5k/128k)"
	const contextUsage = status?.context_usage;
	const contextPercent =
		contextUsage != null ? `${(contextUsage * 100).toFixed(1)}%` : "0.0%";
	const contextTokens = status?.context_tokens;
	const maxContextTokens = status?.max_context_tokens;
	const contextDetail =
		contextTokens != null && maxContextTokens != null && maxContextTokens > 0
			? ` (${formatTokenCount(contextTokens)}/${formatTokenCount(maxContextTokens)})`
			: "";

	// Shorten workDir
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const displayDir = workDir
		? workDir.startsWith(home)
			? "~" + workDir.slice(home.length)
			: workDir
		: "";

	// Git badge — match Python format: "main [± ↑1]"
	let gitBadge = "";
	if (gitBranch) {
		gitBadge = truncate(gitBranch, 22);
		const parts: string[] = [];
		if (gitDirty) parts.push("±");
		if (gitAhead > 0) parts.push(`↑${gitAhead}`);
		if (gitBehind > 0) parts.push(`↓${gitBehind}`);
		if (parts.length > 0) {
			gitBadge += ` [${parts.join(" ")}]`;
		}
	}

	// Build mode string — match Python: "agent (kimi-k2.5 ●)" / "shell"
	const thinkingDot = thinking ? "●" : "○";
	const modeStr = shellMode
		? "shell"
		: modelName
			? `agent (${modelName} ${thinkingDot})`
			: "agent";

	// Rotating tips: build both 2-tip and 1-tip variants for progressive shrinking.
	let tip1Text = "";
	let tip2Text = "";
	if (tips.length > 0) {
		tip1Text = tips[tipIndex % tips.length]!;
		if (tips.length > 1) {
			const tip2 = tips[(tipIndex + 1) % tips.length]!;
			tip2Text = `${tip1Text} | ${tip2}`;
		}
	}

	// --- Line 1: fit all elements into one row, dropping from the end ---
	// Build an ordered list of segments. Each segment has a text representation
	// and a render function. We measure total width and drop segments from the
	// *end* (lowest priority) until the line fits within `columns`.
	//
	// Priority (highest first, i.e. dropped last):
	//   plan/yolo > modeStr > workDir > gitBadge > compacting > bgTask > tips
	//
	// The gap between left-side segments is 2 chars ("  ").

	type Segment = {
		key: string;
		text: string;
		render: () => React.ReactNode;
	};

	const leftSegments: Segment[] = [];

	// plan and yolo display first (and are highest priority — dropped last)
	if (planMode) {
		leftSegments.push({
			key: "plan",
			text: "plan",
			render: () => (
				<Text key="plan" color="cyan" bold>
					plan
				</Text>
			),
		});
	}

	if (yolo) {
		leftSegments.push({
			key: "yolo",
			text: "yolo",
			render: () => (
				<Text key="yolo" color="yellow" bold>
					yolo
				</Text>
			),
		});
	}

	leftSegments.push({
		key: "mode",
		text: modeStr,
		render: () => <Text key="mode">{modeStr}</Text>,
	});

	if (displayDir) {
		const dir = truncate(displayDir, 30);
		leftSegments.push({
			key: "dir",
			text: dir,
			render: () => (
				<Text key="dir" color={DIM}>
					{dir}
				</Text>
			),
		});
	}

	if (gitBadge) {
		leftSegments.push({
			key: "git",
			text: gitBadge,
			render: () => (
				<Text key="git" color={DIM}>
					{gitBadge}
				</Text>
			),
		});
	}

	if (isCompacting) {
		leftSegments.push({
			key: "compact",
			text: "compacting...",
			render: () => (
				<Text key="compact" color="yellow">
					compacting...
				</Text>
			),
		});
	}

	if (bgTaskCount > 0) {
		const t = `⚙ bash: ${bgTaskCount}`;
		leftSegments.push({
			key: "bg",
			text: t,
			render: () => (
				<Text key="bg" color={BG_TASKS_COLOR}>
					{t}
				</Text>
			),
		});
	}

	// Tips go on the right side and are the first to be dropped.
	const GAP = 2; // gap between left segments rendered by Ink's gap={2}
	const LEFT_RIGHT_GAP = 2; // minimum gap between left group and right tips

	const calcLeftWidth = (segs: Segment[]) =>
		segs.reduce((w, s, i) => w + s.text.length + (i > 0 ? GAP : 0), 0);

	let visibleLeft = [...leftSegments];

	// Try 2-tip → 1-tip → no tip
	const calcTotal = (tip: string) => {
		const lw = calcLeftWidth(visibleLeft);
		return tip ? lw + LEFT_RIGHT_GAP + tip.length : lw;
	};

	let visibleTip = "";
	if (tip2Text && calcTotal(tip2Text) <= columns) {
		visibleTip = tip2Text;
	} else if (tip1Text && calcTotal(tip1Text) <= columns) {
		visibleTip = tip1Text;
	}

	// Phase 2: drop left segments from the end (lowest priority first),
	// but never drop the very first segment (plan/yolo/modeStr).
	while (calcTotal(visibleTip) > columns && visibleLeft.length > 1) {
		visibleLeft.pop();
	}

	// Phase 3: if still too wide, truncate the last remaining segment
	if (calcTotal(visibleTip) > columns && visibleLeft.length === 1) {
		const lastSeg = visibleLeft[0]!;
		const maxLen = Math.max(
			5,
			columns - (visibleTip ? visibleTip.length + LEFT_RIGHT_GAP : 0),
		);
		const truncated = truncate(lastSeg.text, maxLen);
		visibleLeft[0] = {
			key: lastSeg.key,
			text: truncated,
			render: () => <Text key={lastSeg.key}>{truncated}</Text>,
		};
	}

	// Left toast (first unexpired toast with position=left)
	const leftToast = toasts.find((t) => (t.position ?? "left") === "left");
	const leftToastText = leftToast
		? `${leftToast.title}${leftToast.body ? `: ${leftToast.body}` : ""}`
		: "";

	// Right side: context info
	const rightText = `context: ${contextPercent}${contextDetail}`;

	// Separator
	const separator = "─".repeat(columns);

	return (
		<Box flexDirection="column">
			{/* Separator line above status bar — matches Python's palette 239 */}
			<Text color={SEPARATOR_COLOR}>{separator}</Text>

			{/* Line 1: status indicators — guaranteed single row */}
			<Box>
				<Box gap={2} flexShrink={0}>
					{visibleLeft.map((seg) => seg.render())}
				</Box>
				{visibleTip && (
					<Box flexGrow={1} justifyContent="flex-end" flexShrink={0}>
						<Text color={TIP_COLOR}>{visibleTip}</Text>
					</Box>
				)}
			</Box>

			{/* Line 2: left toast + right context */}
			<Box justifyContent="space-between">
				<Box>
					{leftToastText ? (
						<Text
							color={
								leftToast?.severity === "error"
									? "#ff7b72"
									: leftToast?.severity === "warning"
										? "#f2cc60"
										: "#56a4ff"
							}
						>
							{truncate(
								leftToastText,
								Math.max(0, columns - rightText.length - 4),
							)}
						</Text>
					) : (
						<Text> </Text>
					)}
				</Box>
				<Box>
					<Text>{rightText}</Text>
				</Box>
			</Box>
		</Box>
	);
}

/**
 * Format token count matching Python: 123, 28.5k, 1.2M
 * Drops trailing .0 (e.g. "128k" not "128.0k")
 */
function formatTokenCount(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) {
		const k = count / 1000;
		return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
	}
	const m = count / 1_000_000;
	return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen - 1) + "…";
}
