/**
 * context-types.ts — Types for context.jsonl deserialization.
 *
 * These types correspond to Python's kosong library message types
 * (packages/kosong/src/kosong/message.py). Context.jsonl may contain
 * messages in either Python (kosong) or TS (Anthropic-style) format,
 * so we define a union that covers both.
 *
 * This is the single source of truth for what /debug renders.
 */

// ── Content Part types (kosong-compatible) ──────────────

/**
 * Text content.
 * Python: TextPart(type="text", text="...")
 * TS:     { type: "text", text: "..." }
 */
export interface KTextPart {
	type: "text";
	text: string;
}

/**
 * Thinking/reasoning content.
 * Python: ThinkPart(type="think", think="...", encrypted=None)
 * TS:     stored as reasoning_content field on message (not as ContentPart)
 */
export interface KThinkPart {
	type: "think";
	think: string;
	encrypted?: string | null;
}

/**
 * Image URL content (Python/kosong format).
 * Python: ImageURLPart(type="image_url", image_url={url, id?})
 */
export interface KImageURLPart {
	type: "image_url";
	image_url: {
		url: string;
		id?: string | null;
	};
}

/**
 * Image content (TS/Anthropic format).
 * TS: { type: "image", source: { type: "base64"|"url", data: "...", mediaType?: "..." } }
 */
export interface KImagePart {
	type: "image";
	source: {
		type: "base64" | "url";
		data: string;
		mediaType?: string;
	};
}

/**
 * Audio URL content (Python/kosong format).
 * Python: AudioURLPart(type="audio_url", audio_url={url, id?})
 */
export interface KAudioURLPart {
	type: "audio_url";
	audio_url: {
		url: string;
		id?: string | null;
	};
}

/**
 * Video URL content (Python/kosong format).
 * Python: VideoURLPart(type="video_url", video_url={url, id?})
 */
export interface KVideoURLPart {
	type: "video_url";
	video_url: {
		url: string;
		id?: string | null;
	};
}

/**
 * Tool use content (TS/Anthropic format, stored in content array).
 * TS: { type: "tool_use", id: "...", name: "...", input: {...} }
 */
export interface KToolUsePart {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}

/**
 * Tool result content (TS/Anthropic format, stored in content array).
 * TS: { type: "tool_result", toolUseId: "...", content: "...", isError?: bool }
 */
export interface KToolResultPart {
	type: "tool_result";
	toolUseId: string;
	content: string;
	isError?: boolean;
}

/**
 * Union of all known content part types from both Python and TS formats.
 * The debug panel must handle all of these.
 */
export type KContentPart =
	| KTextPart
	| KThinkPart
	| KImageURLPart
	| KImagePart
	| KAudioURLPart
	| KVideoURLPart
	| KToolUsePart
	| KToolResultPart;

// ── Tool Call (Python/kosong format, separate from content) ──

/**
 * Tool call as stored in Python's message.tool_calls array.
 * Python: ToolCall(type="function", id="...", function={name, arguments})
 */
export interface KToolCall {
	type: "function";
	id: string;
	function: {
		name: string;
		arguments: string | null;
	};
	extras?: Record<string, unknown> | null;
}

// ── Message (union of Python and TS formats) ─────────────

export type KRole = "system" | "developer" | "user" | "assistant" | "tool";

/**
 * A message as stored in context.jsonl.
 * Covers both Python (kosong) and TS (Anthropic-style) formats.
 */
export interface KMessage {
	role: KRole;

	/** Message content: string (single text) or array of content parts. */
	content: string | KContentPart[];

	// ── Python/kosong format fields ──
	/** Display name (Python: msg.name) */
	name?: string | null;
	/** Tool calls requested by assistant (Python format). */
	tool_calls?: KToolCall[] | null;
	/** Tool call ID this message responds to (Python format). */
	tool_call_id?: string | null;
	/** Whether this is a partial/streaming message. */
	partial?: boolean | null;

	// ── TS-specific fields ──
	/** Thinking content stored separately (TS format, not in content array). */
	reasoning_content?: string;
}

// ── Context info for debug display ───────────────────────

export interface KContextInfo {
	totalMessages: number;
	tokenCount: number;
	checkpoints: number;
	trajectory?: string;
}
