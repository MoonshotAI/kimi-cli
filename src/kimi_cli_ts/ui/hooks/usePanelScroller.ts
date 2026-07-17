/**
 * usePanelScroller.ts — Pure calculation hook for windowing/scrolling in list-based panels.
 *
 * Computes which items are visible given total count, terminal height, and optional focus index.
 * No rendering, no keyboard handling — just windowing math.
 */

import { useMemo } from "react";
import { getTerminalSize } from "../shell/console.ts";

export interface PanelScrollerOptions {
	totalItems: number;
	maxVisible?: number;
	focusedIndex?: number;
	minVisible?: number;
	terminalReservedLines?: number;
}

export interface PanelScrollerReturn {
	startIndex: number;
	endIndex: number;
	hasAbove: boolean;
	hasBelow: boolean;
	aboveCount: number;
	belowCount: number;
	visibleCount: number;
}

export function usePanelScroller(
	options: PanelScrollerOptions,
): PanelScrollerReturn {
	const {
		totalItems,
		maxVisible: maxVisibleOverride,
		focusedIndex,
		minVisible = 5,
		terminalReservedLines = 8,
	} = options;

	return useMemo(() => {
		const maxVisible =
			maxVisibleOverride ??
			Math.max(minVisible, getTerminalSize().rows - terminalReservedLines);

		if (totalItems <= maxVisible) {
			return {
				startIndex: 0,
				endIndex: totalItems,
				hasAbove: false,
				hasBelow: false,
				aboveCount: 0,
				belowCount: 0,
				visibleCount: totalItems,
			};
		}

		let start: number;
		if (focusedIndex != null) {
			start = Math.max(
				0,
				Math.min(
					focusedIndex - Math.floor(maxVisible / 2),
					totalItems - maxVisible,
				),
			);
		} else {
			start = 0;
		}

		const end = Math.min(totalItems, start + maxVisible);

		return {
			startIndex: start,
			endIndex: end,
			hasAbove: start > 0,
			hasBelow: end < totalItems,
			aboveCount: start,
			belowCount: totalItems - end,
			visibleCount: end - start,
		};
	}, [
		totalItems,
		maxVisibleOverride,
		focusedIndex,
		minVisible,
		terminalReservedLines,
	]);
}
