/**
 * MentionMenu.tsx — File mention completion menu.
 * Renders below the input when @ is typed, similar to SlashMenu.
 */

import React from "react";
import { Box, Text, useStdout } from "ink";

const DIM = "#888888";
const HIGHLIGHT_BG = "#1e90ff";

interface MentionMenuProps {
	suggestions: string[];
	selectedIndex: number;
}

export function MentionMenu({ suggestions, selectedIndex }: MentionMenuProps) {
	const { stdout } = useStdout();
	const columns = stdout?.columns ?? 80;

	if (suggestions.length === 0) return null;

	const separator = "─".repeat(columns);

	return (
		<Box flexDirection="column">
			<Text color={DIM}>{separator}</Text>
			{suggestions.map((path, i) => {
				const isSelected = i === selectedIndex;
				const isDir = path.endsWith("/");
				return (
					<Box key={path}>
						<Text color={isSelected ? HIGHLIGHT_BG : DIM}>
							{isSelected ? "▸ " : "  "}
						</Text>
						<Text
							bold={isSelected}
							color={isSelected ? HIGHLIGHT_BG : isDir ? "#56a4ff" : undefined}
						>
							{path}
						</Text>
					</Box>
				);
			})}
		</Box>
	);
}
