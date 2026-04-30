/**
 * ReplayPanel.tsx — Session reconnection replay.
 * Corresponds to Python's ui/shell/replay.py.
 *
 * Features:
 * - Replays the most recent turns when reconnecting to a session
 * - Shows user messages and assistant responses
 * - Renders tool calls and results
 */

import React from "react";
import { Box, Text } from "ink";
import type { WireUIEvent } from "./events";

const MAX_REPLAY_TURNS = 5;

// ── Types ───────────────────────────────────────────────

export interface ReplayTurn {
	userInput: string;
	events: ReplayEvent[];
	stepCount: number;
}

export interface ReplayEvent {
	type:
		| "text"
		| "think"
		| "tool_call"
		| "tool_result"
		| "step_begin"
		| "notification"
		| "plan_display";
	text?: string;
	toolName?: string;
	toolArgs?: string;
	toolCallId?: string;
	isError?: boolean;
	title?: string;
	body?: string;
	content?: string;
	filePath?: string;
}

export interface ReplayPanelProps {
	turns: ReplayTurn[];
}

// ── ReplayTurnView ──────────────────────────────────────

function ReplayTurnView({ turn }: { turn: ReplayTurn }) {
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<Text color="green" bold>
					You:{" "}
				</Text>
				<Text>{turn.userInput}</Text>
			</Box>
			{turn.events.map((event, idx) => (
				<ReplayEventView key={idx} event={event} />
			))}
		</Box>
	);
}

// ── ReplayEventView ─────────────────────────────────────

function ReplayEventView({ event }: { event: ReplayEvent }) {
	switch (event.type) {
		case "text":
			return <Text>{event.text}</Text>;
		case "think":
			return (
				<Box
					borderStyle="single"
					borderColor="grey"
					paddingX={1}
					marginLeft={2}
				>
					<Text color="grey" italic>
						💭 {event.text}
					</Text>
				</Box>
			);
		case "tool_call":
			return (
				<Box marginLeft={2}>
					<Text color="yellow">⟳ </Text>
					<Text color="yellow" bold>
						{event.toolName}
					</Text>
					{event.toolArgs && (
						<Text color="grey"> {truncate(event.toolArgs, 60)}</Text>
					)}
				</Box>
			);
		case "tool_result":
			return (
				<Box marginLeft={4}>
					<Text color={event.isError ? "red" : "green"}>
						{event.isError ? "✗" : "✓"}{" "}
					</Text>
					{event.text && <Text color="grey">{truncate(event.text, 100)}</Text>}
				</Box>
			);
		case "notification":
			return (
				<Box marginLeft={2}>
					<Text color="#56a4ff">ℹ </Text>
					<Text color="#6b7280">
						[{event.title}] {event.body}
					</Text>
				</Box>
			);
		case "plan_display":
			return (
				<Box marginLeft={2} flexDirection="column">
					<Text color="#56a4ff" bold>
						📋 Plan
					</Text>
					{event.content && (
						<Text color="#9ca3af">{truncate(event.content, 200)}</Text>
					)}
				</Box>
			);
		case "step_begin":
			return null;
		default:
			return null;
	}
}

// ── ReplayPanel ─────────────────────────────────────────

export function ReplayPanel({ turns }: ReplayPanelProps) {
	if (turns.length === 0) return null;

	const recentTurns = turns.slice(-MAX_REPLAY_TURNS);

	return (
		<Box flexDirection="column">
			<Text dimColor italic>
				─── Replaying recent history ───
			</Text>
			{recentTurns.map((turn, idx) => (
				<ReplayTurnView key={idx} turn={turn} />
			))}
			<Text dimColor italic>
				─── End of replay ───
			</Text>
		</Box>
	);
}

// ── Helpers ─────────────────────────────────────────────

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen) + "…";
}

/**
 * Build replay turns from wire events.
 */
export function buildReplayTurnsFromEvents(
	events: WireUIEvent[],
): ReplayTurn[] {
	const turns: ReplayTurn[] = [];
	let currentTurn: ReplayTurn | null = null;

	for (const event of events) {
		switch (event.type) {
			case "turn_begin":
				currentTurn = { userInput: event.userInput, events: [], stepCount: 0 };
				turns.push(currentTurn);
				break;
			case "step_begin":
				if (currentTurn) {
					currentTurn.stepCount = event.n;
					currentTurn.events.push({ type: "step_begin" });
				}
				break;
			case "text_delta":
				if (currentTurn) {
					const last = currentTurn.events[currentTurn.events.length - 1];
					if (last && last.type === "text") {
						last.text = (last.text || "") + event.text;
					} else {
						currentTurn.events.push({ type: "text", text: event.text });
					}
				}
				break;
			case "think_delta":
				if (currentTurn) {
					const last = currentTurn.events[currentTurn.events.length - 1];
					if (last && last.type === "think") {
						last.text = (last.text || "") + event.text;
					} else {
						currentTurn.events.push({ type: "think", text: event.text });
					}
				}
				break;
			case "tool_call":
				if (currentTurn) {
					currentTurn.events.push({
						type: "tool_call",
						toolName: event.name,
						toolArgs: event.arguments,
						toolCallId: event.id,
					});
				}
				break;
			case "tool_result":
				if (currentTurn) {
					currentTurn.events.push({
						type: "tool_result",
						toolCallId: event.toolCallId,
						text: event.result.return_value.output,
						isError: event.result.return_value.isError,
					});
				}
				break;
			case "notification":
				if (currentTurn) {
					currentTurn.events.push({
						type: "notification",
						title: event.title,
						body: event.body,
					});
				}
				break;
			case "plan_display":
				if (currentTurn) {
					currentTurn.events.push({
						type: "plan_display",
						content: (event as any).content,
						filePath: (event as any).filePath,
					});
				}
				break;
			case "turn_end":
				currentTurn = null;
				break;
		}
	}

	return turns.slice(-MAX_REPLAY_TURNS);
}

export default ReplayPanel;
