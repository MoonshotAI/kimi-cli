/**
 * Tool registry — register, find, and list all tools.
 * Also acts as a DI container for ToolContext.
 * Corresponds to Python tools/__init__.py and tools/registry.
 */

import type { CallableTool } from "./base.ts";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.ts";
import { SkipThisTool, extractKeyArgument } from "./types.ts";

// Re-export for convenience
export { SkipThisTool, extractKeyArgument };

export class ToolRegistry {
	private tools = new Map<string, CallableTool>();
	private _ctx: ToolContext;

	constructor(ctx: ToolContext) {
		this._ctx = ctx;
	}

	get context(): ToolContext {
		return this._ctx;
	}

	/** Register a tool instance. Silently skips if SkipThisTool is thrown during construction. */
	register(tool: CallableTool): void {
		if (this.tools.has(tool.name)) {
			throw new Error(`Tool "${tool.name}" is already registered.`);
		}
		this.tools.set(tool.name, tool);
	}

	/**
	 * Safely register a tool, catching SkipThisTool during construction.
	 * Returns true if registered, false if skipped.
	 */
	tryRegister(factory: () => CallableTool): boolean {
		try {
			const tool = factory();
			this.register(tool);
			return true;
		} catch (e) {
			if (e instanceof SkipThisTool) {
				return false;
			}
			throw e;
		}
	}

	/** Remove a tool by name. Returns true if it existed. */
	remove(name: string): boolean {
		return this.tools.delete(name);
	}

	/** Find a tool by name. */
	find(name: string): CallableTool | undefined {
		return this.tools.get(name);
	}

	/** List all registered tools. */
	list(): CallableTool[] {
		return [...this.tools.values()];
	}

	/** Get all tool definitions for LLM function calling. */
	definitions(): ToolDefinition[] {
		return this.list().map((t) => t.toDefinition());
	}

	/** Execute a tool by name with raw JSON arguments. */
	async execute(
		name: string,
		rawArgs: Record<string, unknown>,
	): Promise<ToolResult> {
		const tool = this.tools.get(name);
		if (!tool) {
			const msg = `Tool \`${name}\` not found`;
			return {
				isError: true,
				output: msg,
				message: msg,
				display: [{ type: "brief", text: msg }],
			};
		}

		// Validate params through tool schema
		const parsed = tool.schema.safeParse(rawArgs);
		if (!parsed.success) {
			return {
				isError: true,
				output: "",
				message: `Invalid parameters for tool "${name}": ${parsed.error.message}`,
			};
		}

		return tool.execute(parsed.data, this._ctx);
	}

	/** Extract a key argument for display/logging from raw JSON arguments. */
	extractKeyArgument(jsonContent: string, toolName: string): string | null {
		return extractKeyArgument(jsonContent, toolName);
	}
}
