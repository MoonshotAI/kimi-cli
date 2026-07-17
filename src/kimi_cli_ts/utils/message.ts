/**
 * Message utilities — corresponds to Python utils/message.py
 * String representation of messages for display and export.
 */

export interface ContentPart {
	type: string;
	text?: string;
	think?: string;
	[key: string]: unknown;
}

export interface Message {
	role: string;
	content: ContentPart[];
	tool_calls?: ToolCallInfo[];
	tool_call_id?: string;
}

export interface ToolCallInfo {
	id: string;
	function: {
		name: string;
		arguments: string;
	};
}

/**
 * Get a string representation of a message.
 */
export function messageStringify(message: Message): string {
	const parts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text" && part.text) {
			parts.push(part.text);
		} else if (part.type === "image_url") {
			parts.push("[image]");
		} else if (part.type === "audio_url") {
			parts.push("[audio]");
		} else if (part.type === "video_url") {
			parts.push("[video]");
		} else {
			parts.push(`[${part.type}]`);
		}
	}
	return parts.join("");
}
