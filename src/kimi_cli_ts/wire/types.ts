/**
 * Wire event types — corresponds to Python's wire/types.py
 * Uses Zod v4 discriminated unions for runtime validation.
 */

import { z } from "zod/v4";
import {
	ContentPart,
	ToolReturnValue,
	type JsonValue,
} from "../types.ts";

// ── Display Blocks ─────────────────────────────────────────

export const BriefDisplayBlock = z.object({
	type: z.literal("brief"),
	brief: z.string(),
});
export type BriefDisplayBlock = z.infer<typeof BriefDisplayBlock>;

export const DiffDisplayBlock = z.object({
	type: z.literal("diff"),
	path: z.string(),
	old_text: z.string(),
	new_text: z.string(),
	old_start: z.number().default(1),
	new_start: z.number().default(1),
	is_summary: z.boolean().default(false),
});
export type DiffDisplayBlock = z.infer<typeof DiffDisplayBlock>;

export const TodoDisplayItem = z.object({
	title: z.string(),
	status: z.enum(["pending", "in_progress", "done"]),
});
export type TodoDisplayItem = z.infer<typeof TodoDisplayItem>;

export const TodoDisplayBlock = z.object({
	type: z.literal("todo"),
	items: z.array(TodoDisplayItem),
});
export type TodoDisplayBlock = z.infer<typeof TodoDisplayBlock>;

export const ShellDisplayBlock = z.object({
	type: z.literal("shell"),
	language: z.string(),
	command: z.string(),
});
export type ShellDisplayBlock = z.infer<typeof ShellDisplayBlock>;

export const BackgroundTaskDisplayBlock = z.object({
	type: z.literal("background_task"),
	task_id: z.string(),
	kind: z.string(),
	status: z.string(),
	description: z.string(),
});
export type BackgroundTaskDisplayBlock = z.infer<
	typeof BackgroundTaskDisplayBlock
>;

export const UnknownDisplayBlock = z
	.object({
		type: z.string(),
	})
	.passthrough();
export type UnknownDisplayBlock = z.infer<typeof UnknownDisplayBlock>;

export const DisplayBlock = z.union([
	BriefDisplayBlock,
	DiffDisplayBlock,
	TodoDisplayBlock,
	ShellDisplayBlock,
	BackgroundTaskDisplayBlock,
	UnknownDisplayBlock,
]);
export type DisplayBlock = z.infer<typeof DisplayBlock>;

// ── Wire Event Types ───────────────────────────────────────

/** Beginning of a new agent turn. Must be sent before any other event. */
export const TurnBegin = z.object({
	user_input: z.union([z.string(), z.array(ContentPart)]),
});
export type TurnBegin = z.infer<typeof TurnBegin>;

/** User appended follow-up input to the current running turn. */
export const SteerInput = z.object({
	user_input: z.union([z.string(), z.array(ContentPart)]),
});
export type SteerInput = z.infer<typeof SteerInput>;

/** End of the current agent turn. */
export const TurnEnd = z.object({});
export type TurnEnd = z.infer<typeof TurnEnd>;

/** Beginning of a new agent step. */
export const StepBegin = z.object({
	n: z.number(),
});
export type StepBegin = z.infer<typeof StepBegin>;

/** Current step was interrupted. */
export const StepInterrupted = z.object({});
export type StepInterrupted = z.infer<typeof StepInterrupted>;

/** Compaction just began. */
export const CompactionBegin = z.object({});
export type CompactionBegin = z.infer<typeof CompactionBegin>;

/** Compaction just ended. */
export const CompactionEnd = z.object({});
export type CompactionEnd = z.infer<typeof CompactionEnd>;

/** A batch of hooks has been triggered and is now executing. */
export const HookTriggered = z.object({
	event: z.string(),
	target: z.string().default(""),
	hook_count: z.number().default(1),
});
export type HookTriggered = z.infer<typeof HookTriggered>;

/** A batch of hooks has finished executing. */
export const HookResolved = z.object({
	event: z.string(),
	target: z.string().default(""),
	action: z.enum(["allow", "block"]).default("allow"),
	reason: z.string().default(""),
	duration_ms: z.number().default(0),
});
export type HookResolved = z.infer<typeof HookResolved>;

/** MCP tool loading is in progress. */
export const MCPLoadingBegin = z.object({});
export type MCPLoadingBegin = z.infer<typeof MCPLoadingBegin>;

/** MCP tool loading has finished. */
export const MCPLoadingEnd = z.object({});
export type MCPLoadingEnd = z.infer<typeof MCPLoadingEnd>;

/** Snapshot of one MCP server during startup. */
export const MCPServerSnapshot = z.object({
	name: z.string(),
	status: z.enum([
		"pending",
		"connecting",
		"connected",
		"failed",
		"unauthorized",
	]),
	tools: z.array(z.string()).default([]),
});
export type MCPServerSnapshot = z.infer<typeof MCPServerSnapshot>;

/** Snapshot of MCP startup progress. */
export const MCPStatusSnapshot = z.object({
	loading: z.boolean(),
	connected: z.number(),
	total: z.number(),
	tools: z.number(),
	servers: z.array(MCPServerSnapshot).default([]),
});
export type MCPStatusSnapshot = z.infer<typeof MCPStatusSnapshot>;

/** Python-compatible token usage for wire protocol. */
export const WireTokenUsage = z.object({
	input_other: z.number(),
	output: z.number(),
	input_cache_read: z.number().default(0),
	input_cache_creation: z.number().default(0),
});
export type WireTokenUsage = z.infer<typeof WireTokenUsage>;

/** Status update on the current state of the soul. None fields = no change. */
export const StatusUpdate = z.object({
	context_usage: z.number().nullable().default(null),
	context_tokens: z.number().nullable().default(null),
	max_context_tokens: z.number().nullable().default(null),
	token_usage: WireTokenUsage.nullable().default(null),
	message_id: z.string().nullable().default(null),
	plan_mode: z.boolean().nullable().default(null),
	yolo: z.boolean().nullable().default(null),
	mcp_status: MCPStatusSnapshot.nullable().default(null),
});
export type StatusUpdate = z.infer<typeof StatusUpdate>;

/** Generic system notification. */
export const Notification = z.object({
	id: z.string(),
	category: z.string(),
	type: z.string(),
	source_kind: z.string(),
	source_id: z.string(),
	title: z.string(),
	body: z.string(),
	severity: z.string(),
	created_at: z.number(),
	payload: z.record(z.string(), z.unknown()).default({}),
});
export type Notification = z.infer<typeof Notification>;

/** Displays a plan's content inline in the chat. */
export const PlanDisplay = z.object({
	content: z.string(),
	file_path: z.string(),
});
export type PlanDisplay = z.infer<typeof PlanDisplay>;

// ── Content Part types ─────────────────────────────────────

export const TextPart = z.object({
	type: z.literal("text"),
	text: z.string(),
});

export const ThinkPart = z.object({
	type: z.literal("think"),
	text: z.string(),
});

export const ImageURLPart = z.object({
	type: z.literal("image"),
	source: z.object({
		type: z.enum(["base64", "url"]),
		mediaType: z.string().optional(),
		data: z.string(),
	}),
});

export const AudioURLPart = z.object({
	type: z.literal("audio"),
	source: z.object({
		type: z.enum(["base64", "url"]),
		mediaType: z.string().optional(),
		data: z.string(),
	}),
});

export const VideoURLPart = z.object({
	type: z.literal("video"),
	source: z.object({
		type: z.enum(["base64", "url"]),
		mediaType: z.string().optional(),
		data: z.string(),
	}),
});

export const ToolCallPart = z.object({
	type: z.literal("tool_use"),
	id: z.string(),
	name: z.string(),
	input: z.record(z.string(), z.unknown()),
});

// ── ToolResult ─────────────────────────────────────────────

export const ToolResult = z.object({
	tool_call_id: z.string(),
	return_value: ToolReturnValue,
	display: z.array(DisplayBlock).default([]),
});
export type ToolResult = z.infer<typeof ToolResult>;

// ── Approval ───────────────────────────────────────────────

export const ApprovalResponseKind = z.enum([
	"approve",
	"approve_for_session",
	"reject",
]);
export type ApprovalResponseKind = z.infer<typeof ApprovalResponseKind>;

export const ApprovalResponse = z.object({
	request_id: z.string(),
	response: ApprovalResponseKind,
	feedback: z.string().default(""),
});
export type ApprovalResponse = z.infer<typeof ApprovalResponse>;

export const ApprovalRequestSchema = z.object({
	id: z.string(),
	tool_call_id: z.string(),
	sender: z.string(),
	action: z.string(),
	description: z.string(),
	source_kind: z
		.enum(["foreground_turn", "background_agent"])
		.nullable()
		.default(null),
	source_id: z.string().nullable().default(null),
	agent_id: z.string().nullable().default(null),
	subagent_type: z.string().nullable().default(null),
	source_description: z.string().nullable().default(null),
	display: z.array(DisplayBlock).default([]),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

// Keep original schema name for registry
export const ApprovalRequest = ApprovalRequestSchema;

// ── Question ───────────────────────────────────────────────

export const QuestionOption = z.object({
	label: z.string(),
	description: z.string().default(""),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

export const QuestionItem = z.object({
	question: z.string(),
	header: z.string().default(""),
	options: z.array(QuestionOption),
	multi_select: z.boolean().default(false),
	body: z.string().default(""),
	other_label: z.string().default(""),
	other_description: z.string().default(""),
});
export type QuestionItem = z.infer<typeof QuestionItem>;

export const QuestionResponse = z.object({
	request_id: z.string(),
	answers: z.record(z.string(), z.string()),
});
export type QuestionResponse = z.infer<typeof QuestionResponse>;

export const QuestionRequestSchema = z.object({
	id: z.string(),
	tool_call_id: z.string(),
	questions: z.array(QuestionItem),
});
export type QuestionRequest = z.infer<typeof QuestionRequestSchema>;

export const QuestionRequest = QuestionRequestSchema;

export class QuestionNotSupported extends Error {
	constructor() {
		super("Connected client does not support interactive questions");
		this.name = "QuestionNotSupported";
	}
}

// ── Wire ToolCall (nested function structure matching Python) ──

export const WireToolCall = z.object({
	type: z.literal("function"),
	id: z.string(),
	function: z.object({
		name: z.string(),
		arguments: z.string(),
	}),
	extras: z.unknown().nullable(),
});
export type WireToolCall = z.infer<typeof WireToolCall>;

// ── Tool Call Request ──────────────────────────────────────

export const ToolCallRequestSchema = z.object({
	id: z.string(),
	name: z.string(),
	arguments: z.string().nullable(),
});
export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;

export const ToolCallRequest = ToolCallRequestSchema;

// ── Hook ───────────────────────────────────────────────────

export const HookResponse = z.object({
	request_id: z.string(),
	action: z.enum(["allow", "block"]).default("allow"),
	reason: z.string().default(""),
});
export type HookResponse = z.infer<typeof HookResponse>;

export const HookRequestSchema = z.object({
	id: z.string(),
	subscription_id: z.string().default(""),
	event: z.string(),
	target: z.string().default(""),
	input_data: z.record(z.string(), z.unknown()).default({}),
});
export type HookRequest = z.infer<typeof HookRequestSchema>;

export const HookRequest = HookRequestSchema;

// ── SubagentEvent ──────────────────────────────────────────

export const SubagentEvent = z.object({
	parent_tool_call_id: z.string().nullable().default(null),
	agent_id: z.string().nullable().default(null),
	subagent_type: z.string().nullable().default(null),
	event: z.record(z.string(), z.unknown()), // envelope: { type, payload }
});
export type SubagentEvent = z.infer<typeof SubagentEvent>;

// ── Promise-based Async Resolution Wrappers ────────────────

/**
 * Wraps a Request with a Promise for async resolution.
 * Corresponds to Python's Future-based pattern on ApprovalRequest, etc.
 */
export class Deferred<T> {
	readonly promise: Promise<T>;
	private _resolve!: (value: T) => void;
	private _reject!: (err: Error) => void;
	private _settled = false;

	constructor() {
		this.promise = new Promise<T>((resolve, reject) => {
			this._resolve = resolve;
			this._reject = reject;
		});
	}

	get settled(): boolean {
		return this._settled;
	}

	resolve(value: T): void {
		if (!this._settled) {
			this._settled = true;
			this._resolve(value);
		}
	}

	reject(err: Error): void {
		if (!this._settled) {
			this._settled = true;
			this._reject(err);
		}
	}
}

/** ApprovalRequest with async resolution. */
export class PendingApprovalRequest {
	readonly data: ApprovalRequest;
	private _deferred = new Deferred<ApprovalResponseKind>();
	private _feedback = "";

	constructor(data: ApprovalRequest) {
		this.data = data;
	}

	get id(): string {
		return this.data.id;
	}

	get resolved(): boolean {
		return this._deferred.settled;
	}

	get feedback(): string {
		return this._feedback;
	}

	async wait(): Promise<ApprovalResponseKind> {
		return this._deferred.promise;
	}

	resolve(response: ApprovalResponseKind, feedback = ""): void {
		this._feedback = feedback;
		this._deferred.resolve(response);
	}
}

/** QuestionRequest with async resolution. */
export class PendingQuestionRequest {
	readonly data: QuestionRequest;
	private _deferred = new Deferred<Record<string, string>>();

	constructor(data: QuestionRequest) {
		this.data = data;
	}

	get id(): string {
		return this.data.id;
	}

	get resolved(): boolean {
		return this._deferred.settled;
	}

	async wait(): Promise<Record<string, string>> {
		return this._deferred.promise;
	}

	resolve(answers: Record<string, string>): void {
		this._deferred.resolve(answers);
	}

	setException(err: Error): void {
		this._deferred.reject(err);
	}
}

/** ToolCallRequest with async resolution. */
export class PendingToolCallRequest {
	readonly data: ToolCallRequest;
	private _deferred = new Deferred<unknown>();

	constructor(data: ToolCallRequest) {
		this.data = data;
	}

	get id(): string {
		return this.data.id;
	}

	get resolved(): boolean {
		return this._deferred.settled;
	}

	async wait(): Promise<unknown> {
		return this._deferred.promise;
	}

	resolve(result: unknown): void {
		this._deferred.resolve(result);
	}
}

/** HookRequest with async resolution. */
export class PendingHookRequest {
	readonly data: HookRequest;
	private _deferred = new Deferred<{
		action: "allow" | "block";
		reason: string;
	}>();

	constructor(data: HookRequest) {
		this.data = data;
	}

	get id(): string {
		return this.data.id;
	}

	get resolved(): boolean {
		return this._deferred.settled;
	}

	async wait(): Promise<{ action: "allow" | "block"; reason: string }> {
		return this._deferred.promise;
	}

	resolve(action: "allow" | "block", reason = ""): void {
		this._deferred.resolve({ action, reason });
	}
}

export type PendingRequest =
	| PendingApprovalRequest
	| PendingQuestionRequest
	| PendingToolCallRequest
	| PendingHookRequest;

// ── Union Types ────────────────────────────────────────────

/**
 * All possible event types sent over the Wire.
 * Events are fire-and-forget; they do not expect a response.
 */
export type Event =
	| TurnBegin
	| SteerInput
	| TurnEnd
	| StepBegin
	| StepInterrupted
	| HookTriggered
	| HookResolved
	| CompactionBegin
	| CompactionEnd
	| MCPLoadingBegin
	| MCPLoadingEnd
	| StatusUpdate
	| Notification
	| PlanDisplay
	| ApprovalResponse
	| SubagentEvent
	| ToolResult;

/**
 * All possible request types. Requests expect a response.
 */
export type Request =
	| ApprovalRequest
	| ToolCallRequest
	| QuestionRequest
	| HookRequest;

/**
 * Any message sent over the Wire.
 */
export type WireMessage = Event | Request;

// ── Name → Schema registry ────────────────────────────────

export const _wireMessageSchemas: Record<string, z.ZodType<unknown>> = {
	TurnBegin,
	SteerInput,
	TurnEnd,
	StepBegin,
	StepInterrupted,
	CompactionBegin,
	CompactionEnd,
	HookTriggered,
	HookResolved,
	MCPLoadingBegin,
	MCPLoadingEnd,
	StatusUpdate,
	Notification,
	PlanDisplay,
	ApprovalResponse,
	SubagentEvent,
	ToolResult,
	// Requests
	ApprovalRequest,
	ToolCallRequest,
	QuestionRequest,
	HookRequest,
	// Content parts (also valid events in Python)
	// ContentPart is the Python wire name for both TextPart and ThinkPart
	ContentPart: z.object({ type: z.enum(["text", "think"]), text: z.string().optional(), think: z.string().optional() }).passthrough(),
	TextPart,
	ThinkPart,
	ImageURLPart,
	AudioURLPart,
	VideoURLPart,
	ToolCallPart,
	ToolCall: WireToolCall,
	// Backwards compatibility
	ApprovalRequestResolved: ApprovalResponse,
};

/** Known event type names (fire-and-forget). */
const _eventTypeNames = new Set([
	"TurnBegin",
	"SteerInput",
	"TurnEnd",
	"StepBegin",
	"StepInterrupted",
	"CompactionBegin",
	"CompactionEnd",
	"HookTriggered",
	"HookResolved",
	"MCPLoadingBegin",
	"MCPLoadingEnd",
	"StatusUpdate",
	"Notification",
	"PlanDisplay",
	"ApprovalResponse",
	"SubagentEvent",
	"ToolResult",
	"TextPart",
	"ThinkPart",
	"ContentPart",
	"ImageURLPart",
	"AudioURLPart",
	"VideoURLPart",
	"ToolCallPart",
	"ToolCall",
	"ApprovalRequestResolved",
]);

/** Known request type names (expect a response). */
const _requestTypeNames = new Set([
	"ApprovalRequest",
	"ToolCallRequest",
	"QuestionRequest",
	"HookRequest",
]);

// ── WireMessageEnvelope ────────────────────────────────────

export const WireMessageEnvelopeSchema = z.object({
	type: z.string(),
	payload: z.record(z.string(), z.unknown()),
});
export type WireMessageEnvelope = z.infer<typeof WireMessageEnvelopeSchema>;

/**
 * Create an envelope from a typed wire message.
 */
export function toEnvelope(
	typeName: string,
	payload: Record<string, unknown>,
): WireMessageEnvelope {
	return { type: typeName, payload };
}

/**
 * Parse an envelope back into a validated WireMessage.
 * Returns the parsed object and its type name.
 */
export function fromEnvelope(envelope: WireMessageEnvelope): {
	typeName: string;
	message: unknown;
} {
	const schema = _wireMessageSchemas[envelope.type];
	if (!schema) {
		throw new Error(`Unknown wire message type: ${envelope.type}`);
	}
	const message = schema.parse(envelope.payload);
	return { typeName: envelope.type, message };
}

/**
 * Check if a type name corresponds to an Event.
 */
export function isEventTypeName(typeName: string): boolean {
	return _eventTypeNames.has(typeName);
}

/**
 * Check if a type name corresponds to a Request.
 */
export function isRequestTypeName(typeName: string): boolean {
	return _requestTypeNames.has(typeName);
}

/**
 * Get the Zod schema for a wire message type name.
 */
export function getWireMessageSchema(
	typeName: string,
): z.ZodType<unknown> | undefined {
	return _wireMessageSchemas[typeName];
}
