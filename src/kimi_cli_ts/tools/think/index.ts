/**
 * Think tool — give the LLM thinking space.
 * Corresponds to Python tools/think/__init__.py
 */

import { z } from "zod/v4";
import { CallableTool } from "../base.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { ToolOk } from "../types.ts";

const DESCRIPTION =
	"Use the tool to think about something. It will not obtain new information or change the database, but just append the thought to the log. Use it when complex reasoning or some cache memory is needed.";

const ParamsSchema = z.object({
	thought: z.string().describe("A thought to think about."),
});

type Params = z.infer<typeof ParamsSchema>;

export class Think extends CallableTool<typeof ParamsSchema> {
	readonly name = "Think";
	readonly description = DESCRIPTION;
	readonly schema = ParamsSchema;

	async execute(_params: Params, _ctx: ToolContext): Promise<ToolResult> {
		return ToolOk("", "Thought logged");
	}
}
