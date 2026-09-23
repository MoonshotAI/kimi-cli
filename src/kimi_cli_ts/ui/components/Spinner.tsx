/**
 * Spinner component — loading indicators.
 * Uses ink-spinner for animated spinners.
 */

import React from "react";
import { Box, Text } from "ink";
import InkSpinner from "ink-spinner";
import { getMessageColors } from "../theme";

interface SpinnerProps {
	/** Text to display next to the spinner */
	label?: string;
	/** Spinner color */
	color?: string;
}

export function Spinner({ label = "Thinking...", color }: SpinnerProps) {
	const colors = getMessageColors();
	const spinnerColor = color || colors.highlight;

	return (
		<Box>
			<Text color={spinnerColor}>
				<InkSpinner type="dots" />
			</Text>
			{label && <Text color={colors.dim}> {label}</Text>}
		</Box>
	);
}

interface CompactionSpinnerProps {
	/** Whether compaction is in progress */
	active: boolean;
}

export function CompactionSpinner({ active }: CompactionSpinnerProps) {
	if (!active) return null;
	// Match Python exactly: Spinner("balloon", "Compacting...")
	return (
		<Box>
			<Text>
				<InkSpinner type="balloon" />
			</Text>
			<Text> Compacting...</Text>
		</Box>
	);
}

interface StreamingSpinnerProps {
	stepCount: number;
}

export function StreamingSpinner({ stepCount }: StreamingSpinnerProps) {
	// Match Python: StepBegin shows a moon-phase spinner with no text.
	// The "Thinking..." / "Composing..." text is shown by _ContentBlock spinners,
	// not by this top-level streaming indicator.
	return (
		<Box>
			<Text>
				<InkSpinner type="moon" />
			</Text>
		</Box>
	);
}
