/**
 * SetTodoList tool — manage a todo list.
 * Corresponds to Python tools/todo/__init__.py
 */

import { z } from "zod/v4";
import { CallableTool } from "../base.ts";
import type { ToolContext, ToolResult } from "../types.ts";

const DESCRIPTION = `Update the whole todo list.

Todo list is a simple yet powerful tool to help you get things done. Use this tool when the given task involves multiple subtasks/milestones.

Each time you want to operate on the todo list, you need to update the whole. Make sure to maintain the todo items and their statuses properly.`;

const TodoSchema = z.object({
	title: z.string().min(1).describe("The title of the todo"),
	status: z
		.enum(["pending", "in_progress", "done"])
		.describe("The status of the todo"),
});

const ParamsSchema = z.object({
	todos: z.array(TodoSchema).describe("The updated todo list"),
});

type Params = z.infer<typeof ParamsSchema>;

export class SetTodoList extends CallableTool<typeof ParamsSchema> {
	readonly name = "SetTodoList";
	readonly description = DESCRIPTION;
	readonly schema = ParamsSchema;

	async execute(params: Params, _ctx: ToolContext): Promise<ToolResult> {
		return {
			isError: false,
			output: "Todo list updated",
			message: "Todo list updated",
			display: [
				{
					type: "todo",
					items: params.todos.map((t) => ({
						title: t.title,
						status: t.status,
					})),
				},
			],
		};
	}
}
