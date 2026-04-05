/**
 * useReplayHistory — Load and replay conversation history from wire.jsonl on session resume.
 * Corresponds to Python's ui/shell/replay.py.
 *
 * Handles two wire.jsonl formats:
 * 1. TS flat: {"type":"turn_begin","user_input":"hi","ts":123}
 * 2. Python nested: {"timestamp":123,"message":{"type":"TurnBegin","payload":{"user_input":[...]}}}
 */

import { useEffect, useState } from "react";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type { WireUIEvent } from "../shell/events.ts";
import {
	buildReplayTurnsFromEvents,
	type ReplayTurn,
} from "../shell/ReplayPanel.tsx";

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

interface UseReplayHistoryOptions {
	sessionDir?: string;
	enabled?: boolean;
}

export function useReplayHistory({
	sessionDir,
	enabled = true,
}: UseReplayHistoryOptions): {
	turns: ReplayTurn[];
	loading: boolean;
} {
	const [turns, setTurns] = useState<ReplayTurn[]>([]);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		if (!enabled || !sessionDir) {
			setTurns([]);
			return;
		}

		setLoading(true);

		try {
			// Try wire.jsonl first (preferred — has structured events)
			const wirePath = join(sessionDir, "wire.jsonl");
			const wireExists = existsSync(wirePath);

			if (wireExists) {
				const stat = Bun.file(wirePath).size;
				if (stat <= MAX_FILE_SIZE) {
					const content = readFileSync(wirePath, "utf-8");
					const lines = content.split("\n").filter((l) => l.trim());
					const events: WireUIEvent[] = [];
					for (const line of lines) {
						try {
							const obj = JSON.parse(line);
							const event = parseWireLine(obj);
							if (event) events.push(event);
						} catch {
							/* skip */
						}
					}
					const replayTurns = buildReplayTurnsFromEvents(events);
					if (replayTurns.length > 0) {
						setTurns(replayTurns);
						setLoading(false);
						return;
					}
				}
			}

			// Fallback: reconstruct from context.jsonl
			const contextPath = join(sessionDir, "context.jsonl");
			if (existsSync(contextPath)) {
				const stat = Bun.file(contextPath).size;
				if (stat <= MAX_FILE_SIZE) {
					const content = readFileSync(contextPath, "utf-8");
					const replayTurns = buildTurnsFromContext(content);
					setTurns(replayTurns);
					setLoading(false);
					return;
				}
			}

			setTurns([]);
		} catch {
			setTurns([]);
		} finally {
			setLoading(false);
		}
	}, [sessionDir, enabled]);

	return { turns, loading };
}

/**
 * Parse a single wire.jsonl line into a WireUIEvent.
 * Handles both TS flat format and Python nested format.
 */
function parseWireLine(obj: any): WireUIEvent | null {
	if (!obj || typeof obj !== "object") return null;

	// Python nested format: {timestamp, message: {type, payload}}
	if (obj.message && typeof obj.message === "object" && obj.message.type) {
		return parsePythonWireMessage(obj.message);
	}

	// TS flat format: {type, ...fields, ts}
	if (obj.type && typeof obj.type === "string") {
		return parseFlatWireMessage(obj);
	}

	return null;
}

/**
 * Parse Python nested wire message: {type: "TurnBegin", payload: {...}}
 * Python uses ContentPart for both text and think content.
 */
function parsePythonWireMessage(msg: any): WireUIEvent | null {
	const type: string = msg.type;
	const payload: any = msg.payload ?? {};

	if (type === "TurnBegin") {
		const userInput = extractUserInput(payload.user_input);
		if (userInput.startsWith("/clear")) return null;
		return { type: "turn_begin", userInput };
	}

	if (type === "StepBegin") {
		return { type: "step_begin", n: payload.n ?? 1 };
	}

	// Python uses ContentPart for both text and think
	if (type === "ContentPart") {
		const contentType = payload.type;
		if (contentType === "text") {
			return { type: "text_delta", text: payload.text ?? "" };
		}
		if (contentType === "think") {
			return { type: "think_delta", text: payload.think ?? payload.text ?? "" };
		}
		return null;
	}

	// Fallback: TextPart / ThinkPart (in case some versions use these)
	if (type === "TextPart") {
		return { type: "text_delta", text: payload.text ?? "" };
	}

	if (type === "ThinkPart") {
		return { type: "think_delta", text: payload.text ?? "" };
	}

	if (type === "ToolCall") {
		// Python stores tool call as: {type: "function", id: "...", function: {name, arguments}}
		const fn = payload.function ?? {};
		return {
			type: "tool_call",
			id: payload.id ?? "",
			name: fn.name ?? payload.name ?? "",
			arguments:
				typeof fn.arguments === "string"
					? fn.arguments
					: JSON.stringify(fn.arguments ?? payload.arguments ?? {}),
		};
	}

	if (type === "ToolResult") {
		return {
			type: "tool_result",
			toolCallId: payload.tool_call_id ?? "",
			result: {
				return_value: {
					output: payload.output ?? payload.text ?? "",
					isError: payload.is_error ?? false,
				},
			} as any,
		};
	}

	if (type === "TurnEnd") {
		return { type: "turn_end" };
	}

	return null;
}

/**
 * Parse TS flat wire message: {type: "turn_begin", user_input: "...", ts: ...}
 */
function parseFlatWireMessage(obj: any): WireUIEvent | null {
	const type: string = obj.type;

	// Skip metadata lines
	if (type === "metadata") return null;

	if (type === "turn_begin") {
		const userInput =
			typeof obj.user_input === "string" ? obj.user_input : "[complex input]";
		if (userInput.startsWith("/clear")) return null;
		return { type: "turn_begin", userInput };
	}

	if (type === "step_begin") {
		return { type: "step_begin", n: obj.n ?? 1 };
	}

	if (type === "text_part") {
		return { type: "text_delta", text: obj.text ?? "" };
	}

	if (type === "think_part") {
		return { type: "think_delta", text: obj.text ?? "" };
	}

	if (type === "tool_call") {
		return {
			type: "tool_call",
			id: obj.id ?? "",
			name: obj.name ?? "",
			arguments:
				typeof obj.arguments === "string"
					? obj.arguments
					: JSON.stringify(obj.arguments ?? {}),
		};
	}

	if (type === "tool_result") {
		return {
			type: "tool_result",
			toolCallId: obj.tool_call_id ?? "",
			result: {
				return_value: {
					output: obj.output ?? obj.text ?? "",
					isError: obj.is_error ?? false,
				},
			} as any,
		};
	}

	if (type === "turn_end") {
		return { type: "turn_end" };
	}

	return null;
}

/**
 * Extract user input text from various formats.
 * Python wire stores user_input as [{type: "text", text: "..."}] array.
 */
function extractUserInput(userInput: any): string {
	if (typeof userInput === "string") return userInput;
	if (Array.isArray(userInput)) {
		const textParts = userInput
			.filter((p: any) => p.type === "text" && typeof p.text === "string")
			.map((p: any) => p.text);
		return textParts.join("") || "[complex input]";
	}
	return "[complex input]";
}

/**
 * Build replay turns from context.jsonl (fallback when wire.jsonl is missing).
 * context.jsonl stores messages as JSONL with {role, content, tool_calls?, ...}.
 * We reconstruct user/assistant turn pairs from this.
 */
const MAX_CONTEXT_TURNS = 5;

function buildTurnsFromContext(content: string): ReplayTurn[] {
	const lines = content.split("\n").filter((l) => l.trim());
	const messages: any[] = [];

	for (const line of lines) {
		try {
			const obj = JSON.parse(line);
			// Skip internal messages (system prompt, usage, checkpoint, etc.)
			if (!obj.role || obj.role === "system" || obj.role === "developer")
				continue;
			if (obj.role?.startsWith("_")) continue;
			messages.push(obj);
		} catch {
			/* skip */
		}
	}

	// Group into turns: each user message starts a new turn
	const turns: ReplayTurn[] = [];
	let currentTurn: ReplayTurn | null = null;

	for (const msg of messages) {
		if (msg.role === "user") {
			// Extract user text
			const text = extractContentText(msg.content);
			if (!text) continue;
			currentTurn = { userInput: text, events: [], stepCount: 0 };
			turns.push(currentTurn);
		} else if (msg.role === "assistant" && currentTurn) {
			// Extract assistant text content
			const text = extractContentText(msg.content);
			if (text) {
				currentTurn.events.push({ type: "text", text });
			}
			// Extract tool calls
			if (Array.isArray(msg.tool_calls)) {
				for (const tc of msg.tool_calls) {
					const fn = tc.function ?? {};
					currentTurn.events.push({
						type: "tool_call",
						toolName: fn.name ?? tc.name ?? "",
						toolArgs: fn.arguments ?? "",
						toolCallId: tc.id ?? "",
					});
				}
			}
			// TS format: tool_use in content array
			if (Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (part.type === "tool_use") {
						currentTurn.events.push({
							type: "tool_call",
							toolName: part.name ?? "",
							toolArgs:
								typeof part.input === "string"
									? part.input
									: JSON.stringify(part.input ?? {}),
							toolCallId: part.id ?? "",
						});
					}
				}
			}
		} else if (msg.role === "tool" && currentTurn) {
			// Tool result — skip for display (tool calls already shown)
		}
	}

	// Return last N turns
	return turns.slice(-MAX_CONTEXT_TURNS);
}

/** Extract text content from a message's content field. */
function extractContentText(content: any): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((p: any) => p.type === "text" && typeof p.text === "string")
			.map((p: any) => p.text)
			.join("");
	}
	return "";
}
