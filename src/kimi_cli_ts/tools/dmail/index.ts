/**
 * SendDMail tool — send a D-Mail to revert context to a checkpoint.
 * Corresponds to Python tools/dmail/__init__.py
 * Stub: full implementation requires denwa_renji integration.
 */

import { z } from "zod/v4";
import { CallableTool } from "../base.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { ToolOk } from "../types.ts";

const DESCRIPTION = `Send a message to the past, just like sending a D-Mail in Steins;Gate.

This tool is provided to enable you to proactively manage the context. You can see some \`user\` messages with text \`CHECKPOINT {checkpoint_id}\` wrapped in \`<system>\` tags in the context. When you feel there is too much irrelevant information in the current context, you can send a D-Mail to revert the context to a previous checkpoint with a message containing only the useful information.

After a D-Mail is sent, the system will revert the current context to the specified checkpoint. You must make it very clear in the message what you have done/changed, what you have learned, so that your past self can continue the task without confusion.

When sending a D-Mail, DO NOT explain to the user. Just explain to your past self.`;

const ParamsSchema = z.object({
	checkpoint_id: z.string().describe("The checkpoint ID to revert to."),
	message: z
		.string()
		.describe("The message to send to your past self with useful information."),
});

type Params = z.infer<typeof ParamsSchema>;

export class SendDMail extends CallableTool<typeof ParamsSchema> {
	readonly name = "SendDMail";
	readonly description = DESCRIPTION;
	readonly schema = ParamsSchema;

	async execute(params: Params, _ctx: ToolContext): Promise<ToolResult> {
		// Stub: full implementation requires denwa_renji
		return ToolOk(
			"",
			"If you see this message, the D-Mail was NOT sent successfully.",
		);
	}
}
