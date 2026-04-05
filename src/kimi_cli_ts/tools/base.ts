/**
 * Abstract base class for all tools.
 * Corresponds to Python's CallableTool2.
 */

import { z } from "zod/v4";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export abstract class CallableTool<
	TParams extends z.ZodType<any, any> = z.ZodType<any, any>,
> {
	abstract readonly name: string;
	abstract readonly description: string;
	abstract readonly schema: TParams;

	/** Execute the tool with validated parameters. */
	abstract execute(
		params: z.infer<TParams>,
		ctx: ToolContext,
	): Promise<ToolResult>;

	/** Convert this tool into a ToolDefinition for LLM function calling. */
	toDefinition(): ToolDefinition {
		return {
			name: this.name,
			description: this.description,
			parameters: z.toJSONSchema(this.schema) as Record<string, unknown>,
		};
	}
}
