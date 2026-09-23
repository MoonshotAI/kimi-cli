/**
 * Wire event types for UI consumption.
 * Simplified interface that UI components use to render messages.
 */

import type {
	StatusUpdate,
	ApprovalRequest,
	ToolResult,
	DisplayBlock,
} from "../../wire/types";

// ── UI Message Types ──────────────────────────────────────

export type UIMessageRole = "user" | "assistant" | "system" | "tool";

export interface TextSegment {
	type: "text";
	text: string;
}

export interface ThinkSegment {
	type: "think";
	text: string;
}

/** A sub-tool-call from a subagent, displayed as a nested entry. */
export interface FinishedSubCall {
	callId: string;
	toolName: string;
	arguments: string;
	isError: boolean;
}

export interface ToolCallSegment {
	type: "tool_call";
	id: string;
	name: string;
	arguments: string;
	result?: ToolResult;
	collapsed: boolean;
	// Subagent tracking (matches Python _ToolCallBlock)
	subagentId?: string;
	subagentType?: string;
	/** In-flight subagent tool calls keyed by tool_call_id. */
	ongoingSubCalls?: Record<
		string,
		{ id: string; name: string; arguments: string }
	>;
	/** Most recent MAX_SUBAGENT_TOOL_CALLS_TO_SHOW completed sub-calls. */
	finishedSubCalls?: FinishedSubCall[];
	/** Number of finished sub-calls hidden (overflow). */
	nExtraSubCalls?: number;
}

export type MessageSegment = TextSegment | ThinkSegment | ToolCallSegment;

export interface UIMessage {
	id: string;
	role: UIMessageRole;
	segments: MessageSegment[];
	timestamp: number;
}

// ── Wire Events (simplified for UI) ───────────────────────

export type WireUIEvent =
	| { type: "turn_begin"; userInput: string }
	| { type: "turn_end" }
	| { type: "step_begin"; n: number }
	| { type: "step_interrupted" }
	| { type: "text_delta"; text: string }
	| { type: "think_delta"; text: string }
	| { type: "tool_call"; id: string; name: string; arguments: string }
	| { type: "tool_call_delta"; id: string; arguments: string }
	| { type: "tool_result"; toolCallId: string; result: ToolResult }
	| { type: "approval_request"; request: ApprovalRequest }
	| { type: "approval_response"; requestId: string; response: string }
	| {
			type: "question_request";
			request: import("../../wire/types.ts").QuestionRequest;
	  }
	| {
			type: "question_response";
			requestId: string;
			answers: Record<string, string>;
	  }
	| { type: "status_update"; status: StatusUpdate }
	| { type: "compaction_begin" }
	| { type: "compaction_end" }
	| { type: "notification"; title: string; body: string; severity?: string }
	| { type: "slash_result"; text: string }
	| { type: "plan_display"; content: string; filePath: string }
	| { type: "hook_triggered"; event: string; target: string; hookCount: number }
	| {
			type: "hook_resolved";
			event: string;
			target: string;
			action: string;
			reason: string;
			durationMs: number;
	  }
	| { type: "mcp_loading_begin" }
	| { type: "mcp_loading_end" }
	| {
			type: "subagent_event";
			parentToolCallId: string | null;
			agentId: string | null;
			subagentType: string | null;
			event: Record<string, unknown>;
	  }
	| {
			type: "error";
			message: string;
			retryable?: boolean;
			retryAfter?: number;
	  };
