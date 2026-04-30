/**
 * Toolset — corresponds to Python soul/toolset.py
 * Extended tool registry with hook integration, wire event emission,
 * currentToolCall tracking, sessionId context, MCP integration,
 * and external tool support.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { CallableTool } from "../tools/base.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext, ToolResult, ToolDefinition } from "../tools/types.ts";
import { ToolOk, ToolError } from "../tools/types.ts";
import type { HookEngine } from "../hooks/engine.ts";
import type { ToolCall } from "../types.ts";
import type { MCPStatusSnapshot as MCPStatusSnapshotType } from "../wire/types.ts";
import { logger } from "../utils/logging.ts";
import type { Runtime } from "./agent.ts";

// ── Context variables ─────────────────────────────────
// Use AsyncLocalStorage to mirror Python's ContextVar behavior:
// each concurrent execution (Promise / asyncio.Task) gets its own
// value, preventing races when multiple tools run in parallel.

const _toolCallStorage = new AsyncLocalStorage<ToolCall | null>();
let _currentSessionId = "";

/** Set the current session ID for tool call context. */
export function setSessionId(sid: string): void {
	_currentSessionId = sid;
}

/** Get the current session ID. */
export function getSessionId(): string {
	return _currentSessionId;
}

/** Get the current tool call, or null if not in a tool execution. */
export function getCurrentToolCallOrNull(): ToolCall | null {
	return _toolCallStorage.getStore() ?? null;
}

export interface ToolsetOptions {
	context: ToolContext;
	hookEngine?: HookEngine;
	onToolCall?: (toolCall: ToolCall) => void;
	onToolResult?: (toolCallId: string, result: ToolResult) => void;
}

export class KimiToolset {
	private registry: ToolRegistry;
	private hookEngine?: HookEngine;
	private hiddenTools = new Set<string>();
	private onToolCall?: (toolCall: ToolCall) => void;
	private onToolResult?: (toolCallId: string, result: ToolResult) => void;

	// ── MCP fields (mirrors Python toolset.py) ────────
	private _mcpServers = new Map<string, MCPServerInfo>();
	private _mcpLoadingTask: Promise<void> | null = null;
	private _deferredMcpLoad: {
		configs: MCPConfigEntry[];
		runtime: Runtime;
	} | null = null;

	constructor(opts: ToolsetOptions) {
		this.registry = new ToolRegistry(opts.context);
		this.hookEngine = opts.hookEngine;
		this.onToolCall = opts.onToolCall;
		this.onToolResult = opts.onToolResult;
	}

	get context(): ToolContext {
		return this.registry.context;
	}

	// ── Tool management ─────────────────────────────

	add(tool: CallableTool): void {
		this.registry.register(tool);
	}

	find(name: string): CallableTool | undefined {
		return this.registry.find(name);
	}

	list(): CallableTool[] {
		return this.registry.list();
	}

	hide(toolName: string): void {
		this.hiddenTools.add(toolName);
	}

	unhide(toolName: string): void {
		this.hiddenTools.delete(toolName);
	}

	/** Remove a tool entirely. Returns true if it existed. */
	removeTool(toolName: string): boolean {
		this.hiddenTools.delete(toolName);
		return this.registry.remove(toolName);
	}

	/** Get tool definitions for LLM, excluding hidden tools. */
	definitions(): Array<{
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	}> {
		return this.registry
			.list()
			.filter((t) => !this.hiddenTools.has(t.name))
			.map((t) => t.toDefinition());
	}

	// ── Tool execution with hooks ────────────────────

	/**
	 * Dispatch a tool call asynchronously.
	 *
	 * Returns a Promise that is already running (not awaited here),
	 * so the caller can fire multiple handles concurrently and collect
	 * them with Promise.all().
	 *
	 * Mirrors Python's pattern where toolset.handle() returns
	 * asyncio.create_task(_call()) — the task starts immediately and
	 * inherits the ContextVar value set before creation.
	 *
	 * We use AsyncLocalStorage.run() to give each execution its own
	 * currentToolCall value (Python ContextVar equivalent).
	 */
	handle(toolCall: ToolCall): Promise<ToolResult> {
		// Run the async execution inside an AsyncLocalStorage context
		// so getCurrentToolCallOrNull() returns the correct tool call
		// for each concurrent execution — mirrors Python ContextVar.
		return _toolCallStorage.run(toolCall, () =>
			this._executeToolAsync(toolCall),
		);
	}

	/**
	 * Execute a single tool call with hooks.
	 * Runs inside AsyncLocalStorage context — getCurrentToolCallOrNull()
	 * returns the correct ToolCall throughout the execution.
	 */
	private async _executeToolAsync(toolCall: ToolCall): Promise<ToolResult> {
		const { id, name, arguments: argsStr } = toolCall;

		try {
			// Notify about tool call
			this.onToolCall?.(toolCall);

			// Parse arguments
			let args: Record<string, unknown>;
			try {
				args = argsStr ? JSON.parse(argsStr) : {};
			} catch {
				const result: ToolResult = {
					isError: true,
					output: "",
					message: `Failed to parse arguments for tool "${name}": ${argsStr}`,
				};
				this.onToolResult?.(id, result);
				return result;
			}

			// Run PreToolUse hook
			if (this.hookEngine?.hasHooksFor("PreToolUse")) {
				const hookResults = await this.hookEngine.trigger("PreToolUse", {
					matcherValue: name,
					inputData: {
						session_id: _currentSessionId,
						tool_name: name,
						tool_input: args,
						tool_call_id: id,
					},
				});

				for (const hr of hookResults) {
					if (hr.action === "block") {
						const result: ToolResult = {
							isError: true,
							output: "",
							message: `Tool "${name}" blocked by hook: ${hr.reason}`,
						};
						this.onToolResult?.(id, result);
						return result;
					}
				}
			}

			// Execute tool
			let result: ToolResult;
			try {
				result = await this.registry.execute(name, args);
			} catch (err) {
				logger.error(`Tool "${name}" threw an error: ${err}`);
				result = {
					isError: true,
					output: "",
					message: `Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
				};
			}

			// Run PostToolUse / PostToolUseFailure hook (fire-and-forget)
			if (this.hookEngine) {
				const hookEvent = result.isError ? "PostToolUseFailure" : "PostToolUse";
				if (this.hookEngine.hasHooksFor(hookEvent as any)) {
					this.hookEngine
						.trigger(hookEvent as any, {
							matcherValue: name,
							inputData: {
								session_id: _currentSessionId,
								tool_name: name,
								tool_input: args,
								tool_output: (result.output ?? "").slice(0, 2000),
								tool_error: result.isError ? result.message : undefined,
								tool_call_id: id,
							},
						})
						.catch(() => {}); // fire-and-forget
				}
			}

			// Notify about result
			this.onToolResult?.(id, result);

			return result;
		} catch (err) {
			// Defensive: catch any unexpected errors so the caller never hangs
			const result: ToolResult = {
				isError: true,
				output: "",
				message: `Tool "${name}" error: ${err instanceof Error ? err.message : String(err)}`,
			};
			this.onToolResult?.(id, result);
			return result;
		}
	}

	// ── Cleanup ───────────────────────────────────────

	async cleanup(): Promise<void> {
		// Cancel deferred load
		this._deferredMcpLoad = null;
		// Close all MCP clients
		for (const info of this._mcpServers.values()) {
			try {
				await info.client.close();
			} catch {
				// ignore cleanup errors
			}
		}
		this._mcpServers.clear();
	}

	// ── MCP methods (mirrors Python toolset.py) ──────

	/** Get MCP servers info. */
	get mcpServers(): Map<string, MCPServerInfo> {
		return this._mcpServers;
	}

	/** Return a read-only snapshot of current MCP startup state. */
	mcpStatusSnapshot(): MCPStatusSnapshotType | null {
		if (this._mcpServers.size === 0) return null;

		const servers: Array<{
			name: string;
			status: MCPServerStatus;
			tools: string[];
		}> = [];
		for (const [name, info] of this._mcpServers) {
			servers.push({
				name,
				status: info.status,
				tools: info.tools.map((t) => t.name),
			});
		}

		return {
			loading: this.hasPendingMcpTools(),
			connected: servers.filter((s) => s.status === "connected").length,
			total: servers.length,
			tools: servers.reduce((sum, s) => sum + s.tools.length, 0),
			servers,
		};
	}

	/** Store MCP configs for a later background startup. */
	deferMcpToolLoading(configs: MCPConfigEntry[], runtime: Runtime): void {
		this._deferredMcpLoad = { configs: [...configs], runtime };
	}

	/** Return True when MCP loading is configured but has not started yet. */
	hasDeferredMcpTools(): boolean {
		return this._deferredMcpLoad !== null;
	}

	/** Start any deferred MCP loading in the background. */
	async startDeferredMcpToolLoading(): Promise<boolean> {
		if (this._deferredMcpLoad === null) return false;
		if (this._mcpLoadingTask !== null || this._mcpServers.size > 0) {
			this._deferredMcpLoad = null;
			return false;
		}

		const { configs, runtime } = this._deferredMcpLoad;
		this._deferredMcpLoad = null;
		await this.loadMcpTools(configs, runtime, true);
		return true;
	}

	/** Load MCP tools from specified MCP configs. */
	async loadMcpTools(
		mcpConfigs: MCPConfigEntry[],
		runtime: Runtime,
		inBackground = true,
	): Promise<void> {
		// Lazy import to avoid loading MCP SDK unless needed
		const { Client } = await import(
			"@modelcontextprotocol/sdk/client/index.js"
		);
		const { StdioClientTransport } = await import(
			"@modelcontextprotocol/sdk/client/stdio.js"
		);

		const oauthServers = new Map<string, string>();

		const connectServer = async (
			serverName: string,
			serverInfo: MCPServerInfo,
		): Promise<[string, Error | null]> => {
			if (serverInfo.status !== "pending") return [serverName, null];
			serverInfo.status = "connecting";

			try {
				await serverInfo.client.connect(serverInfo.transport!);
				const toolsResponse = await serverInfo.client.listTools();

				for (const tool of toolsResponse.tools) {
					const mcpTool = new MCPTool(serverName, tool, serverInfo.client, {
						runtime,
						timeout: runtime.config.mcp.client.tool_call_timeout_ms,
					});
					serverInfo.tools.push(mcpTool);
					this.add(mcpTool);
				}

				serverInfo.status = "connected";
				logger.info(`Connected MCP server: ${serverName}`);
				return [serverName, null];
			} catch (e) {
				logger.error(
					`Failed to connect MCP server: ${serverName}, error: ${e}`,
				);
				serverInfo.status = "failed";
				return [serverName, e instanceof Error ? e : new Error(String(e))];
			}
		};

		const connect = async (): Promise<void> => {
			// Check OAuth tokens
			const unauthorizedServers = new Map<string, string>();
			for (const [serverName, serverInfo] of this._mcpServers) {
				const serverUrl = oauthServers.get(serverName);
				if (!serverUrl) continue;
				// Skip OAuth token check for now (TODO: implement OAuth token storage)
				serverInfo.status = "unauthorized";
				unauthorizedServers.set(serverName, serverUrl);
			}

			const tasks = [...this._mcpServers.entries()]
				.filter(([_, info]) => info.status === "pending")
				.map(([name, info]) => connectServer(name, info));

			const results = await Promise.all(tasks);
			const failedServers = results.filter(([_, err]) => err !== null);

			if (failedServers.length > 0) {
				const names = failedServers.map(([name]) => name).join(", ");
				logger.error(`Failed to connect MCP servers: ${names}`);
			}
		};

		// Initialize MCP servers
		for (const config of mcpConfigs) {
			if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
				logger.debug("Skipping empty MCP config");
				continue;
			}

			for (const [serverName, serverConfig] of Object.entries(
				config.mcpServers,
			)) {
				// Determine transport type
				let transport: InstanceType<typeof StdioClientTransport>;

				if ("command" in serverConfig && serverConfig.command) {
					// stdio transport
					transport = new StdioClientTransport({
						command: serverConfig.command as string,
						args: (serverConfig.args as string[]) ?? [],
						env: (serverConfig.env as Record<string, string>) ?? undefined,
					});
				} else if ("url" in serverConfig && serverConfig.url) {
					// HTTP transport — for now treat as unsupported, log warning
					// TODO: implement StreamableHTTPClientTransport when needed
					logger.warn(
						`HTTP MCP transport not yet supported for server: ${serverName}`,
					);
					continue;
				} else {
					logger.warn(`Unknown MCP server config for: ${serverName}`);
					continue;
				}

				// Track OAuth servers
				if (
					"auth" in serverConfig &&
					serverConfig.auth === "oauth" &&
					"url" in serverConfig
				) {
					oauthServers.set(serverName, serverConfig.url as string);
				}

				const client = new Client({
					name: `kimi-cli-${serverName}`,
					version: "2.0.0",
				});

				this._mcpServers.set(serverName, {
					status: "pending",
					client,
					tools: [],
					transport,
				});
			}
		}

		if (inBackground) {
			this._mcpLoadingDone = false;
			this._mcpLoadingTask = connect().then(
				() => {
					this._mcpLoadingDone = true;
				},
				(err) => {
					logger.error(`MCP background loading failed: ${err}`);
					this._mcpLoadingDone = true;
				},
			);
		} else {
			await connect();
		}
	}

	/** Return True if the background MCP tool-loading task is still running. */
	hasPendingMcpTools(): boolean {
		return this._mcpLoadingTask !== null && !this._mcpLoadingDone;
	}
	private _mcpLoadingDone = false;

	/** Wait for background MCP tool loading to finish. */
	async waitForMcpTools(): Promise<void> {
		if (!this._mcpLoadingTask) return;
		try {
			await this._mcpLoadingTask;
		} finally {
			this._mcpLoadingTask = null;
			this._mcpLoadingDone = true;
		}
	}

	/** Register an external tool (from wire protocol). */
	registerExternalTool(
		name: string,
		description: string,
		parameters: Record<string, unknown>,
	): [boolean, string | null] {
		const existing = this.find(name);
		if (existing && !(existing instanceof WireExternalTool)) {
			return [false, "tool name conflicts with existing tool"];
		}
		try {
			const tool = new WireExternalTool({ name, description, parameters });
			this.add(tool);
			return [true, null];
		} catch (e) {
			return [false, String(e)];
		}
	}
}

// ── MCP Types ────────────────────────────────────────

/** Status of an MCP server connection. */
export type MCPServerStatus =
	| "pending"
	| "connecting"
	| "connected"
	| "failed"
	| "unauthorized";

/** MCP config entry — matches fastmcp MCPConfig format. */
export interface MCPConfigEntry {
	mcpServers?: Record<string, Record<string, unknown>>;
}

/** Info about a connected MCP server. Mirrors Python MCPServerInfo. */
export interface MCPServerInfo {
	status: MCPServerStatus;
	client: import("@modelcontextprotocol/sdk/client/index.js").Client;
	tools: MCPTool[];
	transport?: import("@modelcontextprotocol/sdk/shared/transport.js").Transport;
}

// ── MCPTool ──────────────────────────────────────────

import { z } from "zod/v4";

/**
 * A tool backed by an MCP server.
 * Mirrors Python MCPTool(CallableTool) in toolset.py.
 */
export class MCPTool implements CallableTool {
	readonly name: string;
	readonly description: string;
	readonly schema: z.ZodType;

	private _mcpTool: { name: string; description?: string; inputSchema: Record<string, unknown> };
	private _client: import("@modelcontextprotocol/sdk/client/index.js").Client;
	private _runtime: Runtime;
	private _timeout: number;
	private _actionName: string;

	constructor(
		serverName: string,
		mcpTool: { name: string; description?: string; inputSchema: Record<string, unknown> },
		client: import("@modelcontextprotocol/sdk/client/index.js").Client,
		opts: { runtime: Runtime; timeout: number },
	) {
		this.name = mcpTool.name;
		this.description =
			`This is an MCP (Model Context Protocol) tool from MCP server \`${serverName}\`.\n\n` +
			(mcpTool.description || "No description provided.");
		this._mcpTool = mcpTool;
		this._client = client;
		this._runtime = opts.runtime;
		this._timeout = opts.timeout;
		this._actionName = `mcp:${mcpTool.name}`;

		// Build a permissive Zod schema from the inputSchema
		this.schema = z.record(z.string(), z.unknown());
	}

	toDefinition(): ToolDefinition {
		return {
			name: this.name,
			description: this.description,
			parameters: this._mcpTool.inputSchema,
		};
	}

	async execute(
		params: Record<string, unknown>,
		ctx: ToolContext,
	): Promise<ToolResult> {
		// Request approval
		const approvalResult = await ctx.approval(
			this.name,
			this._actionName,
			`Call MCP tool \`${this._mcpTool.name}\`.`,
		);
		if (approvalResult.decision !== "approve") {
			return ToolError(
				"The tool call is rejected by the user. " +
					"Stop what you are doing and wait for the user to tell you how to proceed.",
				"",
				[{ type: "brief", brief: "Rejected by user" }],
			);
		}

		try {
			// Call with timeout
			const result = await Promise.race([
				this._client.callTool({
					name: this._mcpTool.name,
					arguments: params,
				}),
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(new Error("MCP tool call timed out")),
						this._timeout,
					),
				),
			]);

			return convertMcpToolResult(result as McpCallToolResult);
		} catch (e) {
			const msg = String(e).toLowerCase();
			if (msg.includes("timeout") || msg.includes("timed out")) {
				return ToolError(
					`Timeout while calling MCP tool \`${this._mcpTool.name}\`. ` +
						"You may explain to the user that the timeout config is set too low.",
					"",
					[{ type: "brief", brief: "Timeout" }],
				);
			}
			throw e;
		}
	}
}

// ── WireExternalTool ─────────────────────────────────

/**
 * A tool that delegates execution to an external wire client.
 * Mirrors Python WireExternalTool(CallableTool) in toolset.py.
 */
export class WireExternalTool implements CallableTool {
	readonly name: string;
	readonly description: string;
	readonly schema: z.ZodType;

	private _parameters: Record<string, unknown>;

	constructor(opts: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	}) {
		this.name = opts.name;
		this.description = opts.description || "No description provided.";
		this._parameters = opts.parameters;
		this.schema = z.record(z.string(), z.unknown());
	}

	toDefinition(): ToolDefinition {
		return {
			name: this.name,
			description: this.description,
			parameters: this._parameters,
		};
	}

	async execute(
		_params: Record<string, unknown>,
		_ctx: ToolContext,
	): Promise<ToolResult> {
		const toolCall = getCurrentToolCallOrNull();
		if (!toolCall) {
			return ToolError(
				"External tool calls must be invoked from a tool call context.",
				"",
				[{ type: "brief", brief: "Invalid tool call" }],
			);
		}

		// Lazy import to avoid circular dependency
		const { getWireOrNull } = await import("./index.ts");
		const wire = getWireOrNull();
		if (!wire) {
			logger.error(
				`Wire is not available for external tool call: ${this.name}`,
			);
			return ToolError("Wire is not available for external tool calls.", "", [
				{ type: "brief", brief: "Wire unavailable" },
			]);
		}

		// Send ToolCallRequest via wireSend and wait for response
		// The wire server handles routing external tool calls to the client
		const { wireSend, wireMsg } = await import("./index.ts");
		const { Deferred } = await import("../wire/types.ts");

		const deferred = new Deferred<unknown>();
		// Emit the tool call request as a wire message
		// The wire server will forward it to the external client
		wireSend(
			wireMsg("ToolCallRequest", {
				id: toolCall.id,
				name: toolCall.name,
				arguments: toolCall.arguments ?? null,
			}),
		);

		// TODO: implement proper response routing for external tool calls
		// For now, return an error indicating this feature is not yet fully implemented
		return ToolError(
			"External tool call response routing is not yet implemented in TypeScript.",
			"",
			[{ type: "brief", brief: "Not implemented" }],
		);
	}
}

// ── MCP Content Conversion ───────────────────────────

/** Minimal type for MCP call_tool result. */
interface McpCallToolResult {
	content: Array<Record<string, unknown>>;
	isError?: boolean;
}

/** Minimal type for converted content parts. */
interface McpContentPart {
	type: string;
	text?: string;
	source?: { type: string; mediaType?: string; data: string };
}

/**
 * Convert a single MCP content block to internal content part.
 * Mirrors kosong.tooling.mcp.convert_mcp_content.
 */
function convertMcpContent(part: Record<string, unknown>): McpContentPart {
	const type = part.type as string;

	if (type === "text") {
		return { type: "text", text: part.text as string };
	}

	if (type === "image") {
		return {
			type: "image",
			source: {
				type: "base64",
				mediaType: part.mimeType as string,
				data: part.data as string,
			},
		};
	}

	if (type === "audio") {
		return {
			type: "audio",
			source: {
				type: "base64",
				mediaType: part.mimeType as string,
				data: part.data as string,
			},
		};
	}

	if (type === "resource") {
		const resource = part.resource as Record<string, unknown> | undefined;
		if (resource && resource.blob) {
			const mimeType = (resource.mimeType as string) || "application/octet-stream";
			if (mimeType.startsWith("image/")) {
				return {
					type: "image",
					source: { type: "base64", mediaType: mimeType, data: resource.blob as string },
				};
			}
			if (mimeType.startsWith("audio/")) {
				return {
					type: "audio",
					source: { type: "base64", mediaType: mimeType, data: resource.blob as string },
				};
			}
		}
	}

	// Fallback: convert to text
	return { type: "text", text: JSON.stringify(part) };
}

/**
 * Convert MCP CallToolResult to internal ToolResult.
 * Mirrors Python convert_mcp_tool_result in toolset.py.
 */
function convertMcpToolResult(result: McpCallToolResult): ToolResult {
	const content: McpContentPart[] = result.content.map(convertMcpContent);

	// Combine text parts into output string
	const output = content
		.filter((p) => p.type === "text" && p.text)
		.map((p) => p.text!)
		.join("\n");

	if (result.isError) {
		return ToolError(
			"Tool returned an error. The output may be error message or incomplete output",
			output,
		);
	}
	return ToolOk(output);
}
