/**
 * CommandPanel.tsx — Self-contained panel components for slash commands.
 *
 * Two modes:
 * - ChoicePanel: selectable list with keyboard navigation
 * - ContentPanel: scrollable text viewer
 *
 * Both use usePanelKeyboard for input (via useInputLayer stack).
 * Both use usePanelScroller for windowing.
 * Both use PanelShell for border rendering.
 */

import React, { useState } from "react";
import { Box, Text, useStdout } from "ink";
import { PanelShell } from "./PanelShell.tsx";
import { usePanelScroller } from "../hooks/usePanelScroller.ts";
import { usePanelKeyboard } from "../hooks/usePanelKeyboard.ts";
import type { CommandPanelConfig } from "../../types.ts";
import { isReload } from "../../cli/errors.ts";

const DIM = "#888888";
const HIGHLIGHT = "#1e90ff";

// ── Choice Panel ─────────────────────────────────────────

interface ChoicePanelProps {
	config: Extract<CommandPanelConfig, { type: "choice" }>;
	onClose: () => void;
	onChain: (next: CommandPanelConfig) => void;
	/** Called when a chained panel triggers a Reload (e.g. /model → thinking → save → reload). */
	onReload?: (sessionId: string, prefillText?: string) => void;
}

export function ChoicePanel({ config, onClose, onChain, onReload }: ChoicePanelProps) {
	const { items, title } = config;
	const initialIndex = Math.max(
		0,
		items.findIndex((i) => i.current),
	);
	const [selectedIndex, setSelectedIndex] = useState(initialIndex);

	const scroller = usePanelScroller({
		totalItems: items.length,
		focusedIndex: selectedIndex,
		minVisible: 5,
		terminalReservedLines: 8,
	});

	usePanelKeyboard({
		selectedIndex,
		maxIndex: items.length - 1,
		onIndexChange: setSelectedIndex,
		onEnter: (idx) => {
			const item = items[idx];
			if (!item) return;
			const result = config.onSelect(item.value);
			if (!result) {
				onClose();
			} else if (result instanceof Promise) {
				result.then(
					(next) => (next ? onChain(next) : onClose()),
					(err) => {
						// Propagate Reload errors so the shell can handle session reload
						// (e.g. /model → thinking panel → save config → throw Reload)
						if (isReload(err) && onReload) {
							onReload(err.sessionId ?? "", err.prefillText ?? undefined);
							return;
						}
						onClose();
					},
				);
			} else {
				onChain(result);
			}
		},
		onEscape: onClose,
	});

	const total = items.length;
	const footerLeft =
		total > scroller.visibleCount
			? `[${selectedIndex + 1}/${total}]`
			: undefined;

	return (
		<PanelShell
			variant="rules"
			title={title}
			titleColor={HIGHLIGHT}
			footerHints={["\u2191\u2193 select", "Enter confirm", "Esc cancel"]}
			footerLeft={footerLeft}
		>
			{scroller.hasAbove && <Text color={DIM}> \u2191 more...</Text>}
			{items.slice(scroller.startIndex, scroller.endIndex).map((item, vi) => {
				const i = scroller.startIndex + vi;
				const isSelected = i === selectedIndex;
				return (
					<Box key={item.value} paddingX={1}>
						<Text color={isSelected ? HIGHLIGHT : DIM}>
							{isSelected ? "\u25B8 " : "  "}
						</Text>
						<Text bold={isSelected} color={isSelected ? HIGHLIGHT : undefined}>
							{item.label}
						</Text>
						{item.description && (
							<Text color={DIM}>{"  " + item.description}</Text>
						)}
						{item.current && <Text color={DIM}> (current)</Text>}
					</Box>
				);
			})}
			{scroller.hasBelow && <Text color={DIM}> \u2193 more...</Text>}
		</PanelShell>
	);
}

// ── Content Panel ────────────────────────────────────────

interface ContentPanelProps {
	config: Extract<CommandPanelConfig, { type: "content" }>;
	onClose: () => void;
}

export function ContentPanel({ config, onClose }: ContentPanelProps) {
	const { content, title } = config;
	const { stdout } = useStdout();
	const rows = stdout?.rows ?? 24;
	const maxVisibleLines = Math.max(rows - 8, 10);

	const lines = content.split("\n");
	const maxScroll = Math.max(0, lines.length - maxVisibleLines);
	const [scrollOffset, setScrollOffset] = useState(0);
	const clampedOffset = Math.min(scrollOffset, maxScroll);
	const visibleLines = lines.slice(
		clampedOffset,
		clampedOffset + maxVisibleLines,
	);
	const hasMore = clampedOffset < maxScroll;

	usePanelKeyboard({
		onScrollUp: () => setScrollOffset((o) => Math.max(0, o - 1)),
		onScrollDown: () => setScrollOffset((o) => Math.min(maxScroll, o + 1)),
		onEscape: onClose,
	});

	const footerLeft =
		maxScroll > 0
			? `[${clampedOffset + 1}-${Math.min(clampedOffset + maxVisibleLines, lines.length)}/${lines.length}]`
			: undefined;

	return (
		<PanelShell
			variant="rules"
			title={title}
			titleColor={HIGHLIGHT}
			footerHints={["\u2191\u2193 scroll", "Esc close"]}
			footerLeft={footerLeft}
		>
			<Box flexDirection="column" paddingX={1}>
				{visibleLines.map((line, i) => (
					<Text key={clampedOffset + i}>{line || " "}</Text>
				))}
			</Box>
			{hasMore && <Text color={DIM}> \u2193 more...</Text>}
		</PanelShell>
	);
}
