/**
 * WelcomeBox.tsx — Welcome panel displayed on first render.
 * Matches Python's welcome box layout with logo, directory, session, model info.
 */

import React from "react";
import { Box, Text } from "ink";
import { modelDisplayName } from "../../llm.ts";

// Python uses 256-color palette index 33 = RGB(0, 135, 255) = #0087ff (dodger_blue1)
const KIMI_BLUE = "#0087ff";
// Python uses palette index 244 = RGB(128, 128, 128) = #808080 (grey50)
const GREY_50 = "#808080";

interface WelcomeBoxProps {
	workDir?: string;
	sessionId?: string;
	modelName?: string;
	tip?: string;
}

export function WelcomeBox({
	workDir,
	sessionId,
	modelName,
	tip,
}: WelcomeBoxProps) {
	// Shorten home directory
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const displayDir = workDir
		? workDir.startsWith(home)
			? "~" + workDir.slice(home.length)
			: workDir
		: "~";

	// Apply "powered by" logic matching Python
	const displayModel = modelDisplayName(modelName ?? null);

	return (
		<Box
			borderStyle="round"
			borderColor={KIMI_BLUE}
			flexDirection="column"
			paddingX={2}
			paddingY={1}
		>
			{/* Logo + Welcome */}
			<Box>
				<Box flexDirection="column" marginRight={2} marginLeft={1}>
					<Text color={KIMI_BLUE}>▐█▛█▛█▌</Text>
					<Text color={KIMI_BLUE}>▐█████▌</Text>
				</Box>
				<Box flexDirection="column" justifyContent="center">
					<Text>Welcome to Kimi Code CLI!</Text>
					<Text color={GREY_50}>Send /help for help information.</Text>
				</Box>
			</Box>

			{/* Blank line */}
			<Text> </Text>

			{/* Directory — Python renders entire line in grey50 */}
			<Text color={GREY_50}>Directory: {displayDir}</Text>

			{/* Session */}
			{sessionId && <Text color={GREY_50}>Session: {sessionId}</Text>}

			{/* Model */}
			{displayModel ? (
				<Text color={GREY_50}>Model: {displayModel}</Text>
			) : (
				<Text color="yellow">Model: not set, send /login to login</Text>
			)}

			{/* Tip */}
			{tip && (
				<>
					<Text> </Text>
					<Text color={GREY_50}>Tip: {tip}</Text>
				</>
			)}
		</Box>
	);
}
