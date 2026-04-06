/**
 * Shared types used across the codebase
 * Corresponds to common types from Python's Pydantic models
 */

import { z } from "zod/v4";

// ── Content Types (LLM message content) ──────────────────

export const TextPart = z.object({
	type: z.literal("text"),
	text: z.string(),
});

export const ImagePart = z.object({
	type: z.literal("image"),
	source: z.object({
		type: z.enum(["base64", "url"]),
		mediaType: z.string().optional(),
		data: z.string(),
	}),
});

export const ToolUsePart = z.object({
	type: z.literal("tool_use"),
	id: z.string(),
	name: z.string(),
	input: z.record(z.string(), z.unknown()),
});

export const ToolResultPart = z.object({
	type: z.literal("tool_result"),
	toolUseId: z.string(),
	content: z.string(),
	isError: z.boolean().optional(),
});

export const ThinkPart = z.object({
	type: z.literal("think"),
	think: z.string(),
});

export const ImageURLPart = z.object({
	type: z.literal("image_url"),
	image_url: z.object({
		url: z.string(),
		id: z.string().nullable().default(null),
	}),
});

export const AudioURLPart = z.object({
	type: z.literal("audio_url"),
	audio_url: z.object({
		url: z.string(),
		id: z.string().nullable().default(null),
	}),
});

export const VideoURLPart = z.object({
	type: z.literal("video_url"),
	video_url: z.object({
		url: z.string(),
		id: z.string().nullable().default(null),
	}),
});

export const ContentPart = z.union([
	TextPart,
	ImagePart,
	ImageURLPart,
	AudioURLPart,
	VideoURLPart,
	ToolUsePart,
	ToolResultPart,
	ThinkPart,
]);
export type ContentPart = z.infer<typeof ContentPart>;

// ── Message Types ────────────────────────────────────────

export const Message = z.object({
	role: z.enum(["user", "assistant", "system", "tool"]),
	content: z.union([z.string(), z.array(ContentPart)]),
	reasoning_content: z.string().optional(), // Thinking content (stored separately for now)
});
export type Message = z.infer<typeof Message>;

// ── Usage / Token Tracking ──────────────────────────────

export const TokenUsage = z.object({
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheReadTokens: z.number().optional(),
	cacheWriteTokens: z.number().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

// ── Model Capabilities ──────────────────────────────────

export const ModelCapability = z.enum([
	"image_in",
	"video_in",
	"thinking",
	"always_thinking",
]);
export type ModelCapability = z.infer<typeof ModelCapability>;

// ── Tool Types ──────────────────────────────────────────

export const ToolCall = z.object({
	id: z.string(),
	name: z.string(),
	arguments: z.string(), // JSON string
});
export type ToolCall = z.infer<typeof ToolCall>;

export const ToolReturnValue = z.object({
	isError: z.boolean().default(false),
	output: z.string(),
	message: z.string().optional(),
	display: z.array(z.unknown()).optional(),
	extras: z.record(z.string(), z.unknown()).optional(),
});
export type ToolReturnValue = z.infer<typeof ToolReturnValue>;

// ── Approval ────────────────────────────────────────────

export type ApprovalDecision = "approve" | "approve_for_session" | "reject";

/** Result returned by the ToolContext.approval callback. */
export interface ApprovalDecisionResult {
	decision: ApprovalDecision;
	feedback: string;
}

// ── Status ──────────────────────────────────────────────

export interface StatusSnapshot {
	contextUsage: number | null;
	contextTokens: number | null;
	maxContextTokens: number | null;
	tokenUsage: TokenUsage | null;
	planMode: boolean;
	yoloEnabled: boolean;
	mcpStatus: Record<string, string> | null;
}

// ── Slash Commands ──────────────────────────────────────

export interface PanelChoiceItem {
	label: string;
	value: string;
	description?: string;
	current?: boolean;
}

import type { KContextInfo, KMessage } from "./ui/shell/context-types.ts";

export type CommandPanelConfig =
	| {
			type: "choice";
			title: string;
			items: PanelChoiceItem[];
			onSelect: (
				value: string,
			) => CommandPanelConfig | Promise<CommandPanelConfig | void> | void;
	  }
	| { type: "content"; title: string; content: string }
	| {
			type: "input";
			title: string;
			placeholder?: string;
			password?: boolean;
			onSubmit: (
				value: string,
			) => CommandPanelConfig | Promise<CommandPanelConfig | void> | void;
	  }
	| { type: "debug"; data: { context: KContextInfo; messages: KMessage[] } }
	| { type: "task" };

export interface SlashCommand {
	name: string;
	description: string;
	/** Extended description shown when selected in menu (up to 3 lines) */
	longDescription?: string;
	aliases?: string[];
	handler: (args: string) => Promise<void | string>;
	/** If defined, selecting from menu renders a secondary panel instead of executing handler */
	panel?: () => CommandPanelConfig | null;
}

// ── JSON utility type ───────────────────────────────────

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };
