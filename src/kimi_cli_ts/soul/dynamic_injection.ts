/**
 * Dynamic injection system — corresponds to Python soul/dynamic_injection.py
 * Provides an extensible provider pattern for injecting dynamic prompts before LLM steps.
 */

import type { Message, ContentPart } from "../types.ts";
import type { KimiSoul } from "./kimisoul.ts";

// ── DynamicInjection ─────────────────────────────────

export interface DynamicInjection {
	/** Identifier, e.g. "plan_mode", "yolo_mode" */
	readonly type: string;
	/** Text content (will be wrapped in <system-reminder> tags) */
	readonly content: string;
}

// ── DynamicInjectionProvider ─────────────────────────

/**
 * Base interface for dynamic injection providers.
 *
 * Called before each LLM step. Implementations handle their own throttling.
 * Providers can access all runtime state via the `soul` parameter.
 */
export interface DynamicInjectionProvider {
	getInjections(
		history: readonly Message[],
		soul: KimiSoul,
	): Promise<DynamicInjection[]>;
}

// ── normalizeHistory ─────────────────────────────────

/**
 * Merge adjacent user messages to produce a clean API input sequence.
 *
 * Dynamic injections are stored as standalone user messages in history;
 * normalization merges them into the adjacent user message.
 *
 * Only `user` role messages are merged. Assistant and tool messages
 * are never merged because their tool_calls / tool_call_id fields
 * form linked pairs that must stay intact.
 */
export function normalizeHistory(messages: readonly Message[]): Message[] {
	if (messages.length === 0) return [];

	const result: Message[] = [];
	for (const msg of messages) {
		const prev = result[result.length - 1];
		if (
			prev &&
			prev.role === "user" &&
			msg.role === "user" &&
			!isNotificationMessage(prev) &&
			!isNotificationMessage(msg)
		) {
			// Merge content
			const prevParts = toContentArray(prev.content);
			const curParts = toContentArray(msg.content);
			result[result.length - 1] = {
				role: "user",
				content: [...prevParts, ...curParts],
			};
		} else {
			result.push(msg);
		}
	}
	return result;
}

// ── Helpers ──────────────────────────────────────────

function toContentArray(
	content: string | readonly ContentPart[],
): ContentPart[] {
	if (typeof content === "string") {
		return [{ type: "text" as const, text: content }];
	}
	return [...content];
}

/**
 * Minimal check: notification messages are user messages whose text
 * starts with a notification tag. This keeps us decoupled from the
 * full notifications module.
 */
function isNotificationMessage(msg: Message): boolean {
	if (msg.role !== "user") return false;
	const text = extractText(msg.content);
	return text.includes("<notification>") || text.includes("<notification ");
}

function extractText(
	content: string | readonly { type: string; [key: string]: unknown }[],
): string {
	if (typeof content === "string") return content;
	return content
		.filter((p): p is { type: "text"; text: string } => p.type === "text")
		.map((p) => p.text)
		.join("");
}
