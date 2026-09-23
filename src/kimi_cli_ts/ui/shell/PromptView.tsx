/**
 * PromptView.tsx — Pure rendering prompt component.
 *
 * Renders the input area: separator + optional panel title + buffered lines
 * + input line with fake cursor. No hooks, no state, no keyboard handling.
 * All data comes from props (driven by useShellInput in Shell).
 */

import React from "react";
import { Box, Text, useStdout } from "ink";
import chalk from "chalk";

export interface PromptViewProps {
	/** Current input text */
	value: string;
	/** Cursor position within value */
	cursorOffset: number;
	/** Multiline buffered lines (from Ctrl+J) */
	bufferedLines: string[];
	/** Prompt symbol (e.g. "✨ ", "$ ", "▸ ") */
	promptSymbol: string;
	/** Panel title (shown above input when in panel_input mode) */
	panelTitle?: string;
	/** Mask characters with • (for password panel input) */
	password?: boolean;
}

export function PromptView({
	value,
	cursorOffset,
	bufferedLines,
	promptSymbol,
	panelTitle,
	password,
}: PromptViewProps) {
	const { stdout } = useStdout();
	const columns = stdout?.columns ?? 80;

	const displayValue = password ? "•".repeat(value.length) : value;
	const renderedValue = renderWithCursor(
		displayValue,
		Math.min(cursorOffset, displayValue.length),
	);

	return (
		<Box flexDirection="column">
			{/* Separator line above prompt — matches Python's palette 240 = #585858 */}
			<Text color="#585858">{"─".repeat(columns)}</Text>

			{/* Panel input title */}
			{panelTitle && (
				<Box paddingX={1}>
					<Text bold color="#0087ff">
						{panelTitle}
					</Text>
					<Text color="#888888"> (Enter submit, Esc cancel)</Text>
				</Box>
			)}

			{/* Buffered lines (multiline via Ctrl+J) */}
			{!panelTitle &&
				bufferedLines.map((line, i) => (
					<Box key={i}>
						<Text color="#555555">{i === 0 ? promptSymbol : "  "}</Text>
						<Text>{line}</Text>
					</Box>
				))}

			{/* Input line with inline cursor */}
			<Box>
				<Text>
					{!panelTitle && bufferedLines.length > 0 ? "  " : promptSymbol}
				</Text>
				<Text>{renderedValue}</Text>
			</Box>
		</Box>
	);
}

/** Render text with a fake inverse cursor at the given offset. */
function renderWithCursor(text: string, offset: number): string {
	if (text.length === 0) {
		return chalk.inverse(" ");
	}
	const before = text.slice(0, offset);
	const cursorChar = offset < text.length ? text[offset]! : " ";
	const after = offset < text.length ? text.slice(offset + 1) : "";
	return before + chalk.inverse(cursorChar) + after;
}
