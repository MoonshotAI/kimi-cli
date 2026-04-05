/**
 * ApprovalPrompt component — approval request UI.
 * Corresponds to Python's approval_panel.py.
 *
 * Shows: action description, display blocks, and approval choices.
 * [y] Allow / [n] Deny / [a] Always allow
 */

import React, { useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { getMessageColors } from "../theme";
import type { ApprovalRequest, ApprovalResponseKind } from "../../wire/types";

interface ApprovalPromptProps {
	request: ApprovalRequest;
	onRespond: (decision: ApprovalResponseKind, feedback?: string) => void;
}

export function ApprovalPrompt({ request, onRespond }: ApprovalPromptProps) {
	const colors = getMessageColors();

	useInput((input, key) => {
		switch (input.toLowerCase()) {
			case "y":
				onRespond("approve");
				break;
			case "n":
				onRespond("reject");
				break;
			case "a":
				onRespond("approve_for_session");
				break;
		}
	});

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor="#f2cc60"
			paddingX={1}
			paddingY={0}
		>
			<Text color="#f2cc60" bold>
				⚠ Approval Required
			</Text>

			{/* Source info */}
			{request.source_description && (
				<Text color={colors.dim}>From: {request.source_description}</Text>
			)}

			{/* Action */}
			<Box marginY={0}>
				<Text color={colors.assistant} bold>
					{request.action}
				</Text>
			</Box>

			{/* Description */}
			<Text color={colors.assistant}>{request.description}</Text>

			{/* Display blocks preview */}
			{request.display.length > 0 && (
				<Box flexDirection="column" marginTop={1}>
					{request.display.slice(0, 3).map((block, idx) => {
						if (block.type === "brief") {
							return (
								<Text key={idx} color={colors.dim}>
									{(block as { brief: string }).brief}
								</Text>
							);
						}
						if (block.type === "shell") {
							return (
								<Text key={idx} color={colors.dim}>
									$ {(block as { command: string }).command}
								</Text>
							);
						}
						return null;
					})}
				</Box>
			)}

			{/* Choices */}
			<Box marginTop={1} gap={2}>
				<Text>
					<Text color="#56d364" bold>
						[y]
					</Text>
					<Text color={colors.assistant}> Allow</Text>
				</Text>
				<Text>
					<Text color="#ff7b72" bold>
						[n]
					</Text>
					<Text color={colors.assistant}> Deny</Text>
				</Text>
				<Text>
					<Text color="#56a4ff" bold>
						[a]
					</Text>
					<Text color={colors.assistant}> Always</Text>
				</Text>
			</Box>
		</Box>
	);
}
