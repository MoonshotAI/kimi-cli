/**
 * Message utility functions — corresponds to Python soul/message.py
 * Helpers for constructing system/tool messages.
 */

import type { ContentPart, Message, ModelCapability } from "../types.ts";

/** Wrap text in <system> tags. */
export function system(message: string): ContentPart {
	return { type: "text", text: `<system>${message}</system>` };
}

/** Wrap text in <system-reminder> tags. */
export function systemReminder(message: string): ContentPart {
	return {
		type: "text",
		text: `<system-reminder>\n${message}\n</system-reminder>`,
	};
}

/** Check whether a message is an internal system-reminder user message. */
export function isSystemReminderMessage(message: Message): boolean {
	if (message.role !== "user") return false;
	if (typeof message.content === "string") {
		return message.content.trim().startsWith("<system-reminder>");
	}
	if (Array.isArray(message.content) && message.content.length === 1) {
		const part = message.content[0]!;
		if (part.type === "text") {
			return part.text.trim().startsWith("<system-reminder>");
		}
	}
	return false;
}

/** Build a tool result message from output. */
export function toolResultMessage(opts: {
	toolCallId: string;
	output: string | ContentPart | ContentPart[];
	isError?: boolean;
	message?: string;
}): Message {
	const parts: ContentPart[] = [];

	if (opts.isError) {
		const errMsg = opts.message ?? "Unknown error";
		parts.push(system(`ERROR: ${errMsg}`));
		const outputParts = outputToContentParts(opts.output);
		parts.push(...outputParts);
	} else {
		if (opts.message) {
			parts.push(system(opts.message));
		}
		const outputParts = outputToContentParts(opts.output);
		parts.push(...outputParts);
		if (parts.length === 0) {
			parts.push(system("Tool output is empty."));
		} else if (!parts.some((p) => p.type === "text")) {
			// Ensure at least one TextPart exists so the LLM API won't reject
			parts.unshift(system("Tool returned non-text content."));
		}
	}

	return {
		role: "tool",
		content: [
			{
				type: "tool_result",
				toolUseId: opts.toolCallId,
				content: parts
					.map((p) => (p.type === "text" ? p.text : JSON.stringify(p)))
					.join("\n"),
				isError: opts.isError,
			},
		],
	};
}

/** Convert various output formats to ContentPart array. */
function outputToContentParts(
	output: string | ContentPart | ContentPart[],
): ContentPart[] {
	if (typeof output === "string") {
		return output ? [{ type: "text", text: output }] : [];
	}
	if (Array.isArray(output)) {
		return output;
	}
	// Single ContentPart
	return [output];
}

/** Check message content for required model capabilities, return missing ones. */
export function checkMessage(
	message: Message,
	modelCapabilities: Set<ModelCapability>,
): Set<ModelCapability> {
	const needed = new Set<ModelCapability>();
	const content = typeof message.content === "string" ? [] : message.content;
	for (const part of content) {
		if (part.type === "image" || (part as any).type === "image_url") needed.add("image_in");
		if ((part as any).type === "video" || (part as any).type === "video_url") needed.add("video_in");
		if ((part as any).type === "thinking") needed.add("thinking");
	}
	// Return only the capabilities that are missing
	const missing = new Set<ModelCapability>();
	for (const cap of needed) {
		if (!modelCapabilities.has(cap)) missing.add(cap);
	}
	return missing;
}
