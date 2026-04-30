/**
 * ACP type aliases — corresponds to Python acp/types.py
 * Type definitions for ACP content blocks and MCP server types.
 */

// ── MCP Server types ────────────────────────────────────

export interface HttpMcpServer {
	type: "http";
	name: string;
	url: string;
	headers?: Array<{ name: string; value: string }>;
}

export interface SseMcpServer {
	type: "sse";
	name: string;
	url: string;
	headers?: Array<{ name: string; value: string }>;
}

export interface McpServerStdio {
	type: "stdio";
	name: string;
	command: string;
	args?: string[];
	env?: Array<{ name: string; value: string }>;
}

export type MCPServer = HttpMcpServer | SseMcpServer | McpServerStdio;

// ── ACP Content Blocks ──────────────────────────────────

export interface TextContentBlock {
	type: "text";
	text: string;
}

export interface ImageContentBlock {
	type: "image";
	data: string;
	mime_type: string;
}

export interface AudioContentBlock {
	type: "audio";
	data: string;
	mime_type: string;
}

export interface TextResourceContents {
	type: "text";
	uri: string;
	text: string;
}

export interface BlobResourceContents {
	type: "blob";
	uri: string;
	blob: string;
}

export type ResourceContents = TextResourceContents | BlobResourceContents;

export interface ResourceContentBlock {
	type: "resource";
	uri: string;
	name: string;
}

export interface EmbeddedResourceContentBlock {
	type: "embedded_resource";
	resource: ResourceContents;
}

export type ACPContentBlock =
	| TextContentBlock
	| ImageContentBlock
	| AudioContentBlock
	| ResourceContentBlock
	| EmbeddedResourceContentBlock;

// ── ACP Tool Call Content ───────────────────────────────

export interface ContentToolCallContent {
	type: "content";
	content: TextContentBlock;
}

export interface FileEditToolCallContent {
	type: "diff";
	path: string;
	old_text: string;
	new_text: string;
}

export interface TerminalToolCallContent {
	type: "terminal";
	terminal_id: string;
}

export type ToolCallContent =
	| ContentToolCallContent
	| FileEditToolCallContent
	| TerminalToolCallContent;

// ── ACP Session Updates ─────────────────────────────────

export interface AgentMessageChunk {
	session_update: "agent_message_chunk";
	content: TextContentBlock;
}

export interface AgentThoughtChunk {
	session_update: "agent_thought_chunk";
	content: TextContentBlock;
}

export interface ToolCallStart {
	session_update: "tool_call";
	tool_call_id: string;
	title: string;
	status: "in_progress" | "completed" | "failed";
	content?: ToolCallContent[];
}

export interface ToolCallProgress {
	session_update: "tool_call_update";
	tool_call_id: string;
	title?: string;
	status: "in_progress" | "completed" | "failed";
	content?: ToolCallContent[];
}

export interface PlanEntry {
	content: string;
	priority: "low" | "medium" | "high";
	status: "pending" | "in_progress" | "completed";
}

export interface AgentPlanUpdate {
	session_update: "plan";
	entries: PlanEntry[];
}

export type SessionUpdate =
	| AgentMessageChunk
	| AgentThoughtChunk
	| ToolCallStart
	| ToolCallProgress
	| AgentPlanUpdate;

// ── ACP Permission ──────────────────────────────────────

export interface PermissionOption {
	option_id: string;
	name: string;
	kind: "allow_once" | "allow_always" | "reject_once";
}

export interface ToolCallUpdate {
	tool_call_id: string;
	title: string;
	content: ToolCallContent[];
}

export interface AllowedOutcome {
	type: "allowed";
	option_id: string;
}

export interface CancelledOutcome {
	type: "cancelled";
}

export type PermissionOutcome = AllowedOutcome | CancelledOutcome;

export interface PermissionResponse {
	outcome: PermissionOutcome;
}

// ── ACP Capabilities ────────────────────────────────────

export interface FsCapabilities {
	read_text_file?: boolean;
	write_text_file?: boolean;
}

export interface TerminalCapabilities {
	create?: boolean;
}

export interface PromptCapabilities {
	embedded_context?: boolean;
	image?: boolean;
	audio?: boolean;
}

export interface McpCapabilities {
	http?: boolean;
	sse?: boolean;
}

export interface SessionListCapabilities {}
export interface SessionResumeCapabilities {}

export interface SessionCapabilities {
	list?: SessionListCapabilities;
	resume?: SessionResumeCapabilities;
}

export interface ClientCapabilities {
	fs?: FsCapabilities;
	terminal?: TerminalCapabilities;
}

export interface AgentCapabilities {
	load_session?: boolean;
	prompt_capabilities?: PromptCapabilities;
	mcp_capabilities?: McpCapabilities;
	session_capabilities?: SessionCapabilities;
}

// ── ACP Auth ────────────────────────────────────────────

export interface AuthMethod {
	id: string;
	name: string;
	description: string;
	field_meta?: Record<string, unknown>;
}

// ── ACP Protocol Types ──────────────────────────────────

export interface Implementation {
	name: string;
	version: string;
}

export interface SessionMode {
	id: string;
	name: string;
	description: string;
}

export interface SessionModeState {
	available_modes: SessionMode[];
	current_mode_id: string;
}

export interface ModelInfo {
	model_id: string;
	name: string;
}

export interface SessionModelState {
	available_models: ModelInfo[];
	current_model_id: string;
}

export interface SessionInfo {
	cwd: string;
	session_id: string;
	title: string;
	updated_at: string;
}

// ── ACP Request / Response ──────────────────────────────

export interface InitializeResponse {
	protocol_version: number;
	agent_capabilities: AgentCapabilities;
	auth_methods: AuthMethod[];
	agent_info: Implementation;
}

export interface NewSessionResponse {
	session_id: string;
	modes: SessionModeState;
	models: SessionModelState;
}

export interface ResumeSessionResponse {
	modes: SessionModeState;
	models: SessionModelState;
}

export interface ForkSessionResponse {
	session_id: string;
	modes: SessionModeState;
	models: SessionModelState;
}

export interface ListSessionsResponse {
	sessions: SessionInfo[];
	next_cursor: string | null;
}

export interface PromptResponse {
	stop_reason: "end_turn" | "max_turn_requests" | "cancelled";
}

export interface AuthenticateResponse {}

export interface AvailableCommand {
	name: string;
	description: string;
}

export interface AvailableCommandsUpdate {
	session_update: "available_commands_update";
	available_commands: AvailableCommand[];
}

// ── ACP Terminal ────────────────────────────────────────

export interface CreateTerminalResponse {
	terminal_id: string;
}

export interface TerminalExitStatus {
	exit_code: number | null;
	signal: string | null;
}

export interface TerminalOutputResponse {
	output: string;
	truncated: boolean;
	exit_status?: TerminalExitStatus;
}

export interface WaitForTerminalExitResponse {
	exit_code: number | null;
}

// ── ACP File Operations ─────────────────────────────────

export interface ReadTextFileResponse {
	content: string;
}

// ── ACP Error ───────────────────────────────────────────

export class ACPRequestError extends Error {
	readonly code: string;
	readonly data?: Record<string, unknown>;

	constructor(code: string, message: string, data?: Record<string, unknown>) {
		super(message);
		this.name = "ACPRequestError";
		this.code = code;
		this.data = data;
	}

	static authRequired(data?: Record<string, unknown>): ACPRequestError {
		return new ACPRequestError(
			"AUTH_REQUIRED",
			"Authentication required",
			data,
		);
	}

	static invalidParams(data?: Record<string, unknown>): ACPRequestError {
		return new ACPRequestError("INVALID_PARAMS", "Invalid parameters", data);
	}

	static internalError(data?: Record<string, unknown>): ACPRequestError {
		return new ACPRequestError("INTERNAL_ERROR", "Internal error", data);
	}
}
