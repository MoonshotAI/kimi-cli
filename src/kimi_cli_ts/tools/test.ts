/**
 * Test tools — simple tools for testing purposes.
 * Corresponds to Python tools/test.py
 */

import { z } from "zod/v4";
import { CallableTool } from "./base.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { ToolOk } from "./types.ts";

// ── Plus ──────────────────────────────────────────

const PlusParamsSchema = z.object({
	a: z.number(),
	b: z.number(),
});

export class Plus extends CallableTool<typeof PlusParamsSchema> {
	readonly name = "plus";
	readonly description = "Add two numbers";
	readonly schema = PlusParamsSchema;

	async execute(
		params: z.infer<typeof PlusParamsSchema>,
		_ctx: ToolContext,
	): Promise<ToolResult> {
		return ToolOk(String(params.a + params.b));
	}
}

// ── Compare ───────────────────────────────────────

const CompareParamsSchema = z.object({
	a: z.number(),
	b: z.number(),
});

export class Compare extends CallableTool<typeof CompareParamsSchema> {
	readonly name = "compare";
	readonly description = "Compare two numbers";
	readonly schema = CompareParamsSchema;

	async execute(
		params: z.infer<typeof CompareParamsSchema>,
		_ctx: ToolContext,
	): Promise<ToolResult> {
		if (params.a > params.b) {
			return ToolOk("greater");
		} else if (params.a < params.b) {
			return ToolOk("less");
		} else {
			return ToolOk("equal");
		}
	}
}

// ── Panic ─────────────────────────────────────────

const PanicParamsSchema = z.object({
	message: z.string(),
});

export class Panic extends CallableTool<typeof PanicParamsSchema> {
	readonly name = "panic";
	readonly description = "Raise an exception to cause the tool call to fail.";
	readonly schema = PanicParamsSchema;

	async execute(
		params: z.infer<typeof PanicParamsSchema>,
		_ctx: ToolContext,
	): Promise<ToolResult> {
		await Bun.sleep(2000);
		throw new Error(
			`panicked with a message with ${params.message.length} characters`,
		);
	}
}
