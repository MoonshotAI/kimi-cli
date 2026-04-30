/**
 * StrReplaceFile tool — edit/replace strings in a file.
 * Corresponds to Python tools/file/replace.py
 */

import { resolve } from "node:path";
import { z } from "zod/v4";
import { buildWireDiffBlocks } from "../../utils/diff.ts";
import { CallableTool } from "../base.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { ToolError, ToolRejectedError } from "../types.ts";
import { inspectPlanEditTarget } from "./plan_mode.ts";

const DESCRIPTION = `Replace specific strings within a specified file.

**Tips:**
- Only use this tool on text files.
- Multi-line strings are supported.
- Can specify a single edit or a list of edits in one call.
- You should prefer this tool over WriteFile tool and Shell \`sed\` command.`;

const EditSchema = z.object({
	old: z.string().describe("The old string to replace. Can be multi-line."),
	new: z
		.string()
		.describe("The new string to replace with. Can be multi-line."),
	replace_all: z
		.boolean()
		.default(false)
		.describe("Whether to replace all occurrences."),
});

const ParamsSchema = z.object({
	path: z
		.string()
		.describe(
			"The path to the file to edit. Absolute paths are required when editing files outside the working directory.",
		),
	edit: z
		.union([EditSchema, z.array(EditSchema)])
		.describe("The edit(s) to apply to the file."),
});

type Params = z.infer<typeof ParamsSchema>;
type Edit = z.infer<typeof EditSchema>;

function resolvePath(filePath: string, workingDir: string): string {
	if (filePath.startsWith("/") || filePath.startsWith("~")) {
		if (filePath.startsWith("~")) {
			const home = process.env.HOME || process.env.USERPROFILE || "";
			return filePath.replace(/^~/, home);
		}
		return filePath;
	}
	return resolve(workingDir, filePath);
}

function applyEdit(content: string, edit: Edit): string {
	if (edit.replace_all) {
		return content.split(edit.old).join(edit.new);
	}
	const idx = content.indexOf(edit.old);
	if (idx === -1) return content;
	return (
		content.slice(0, idx) + edit.new + content.slice(idx + edit.old.length)
	);
}

export class StrReplaceFile extends CallableTool<typeof ParamsSchema> {
	readonly name = "StrReplaceFile";
	readonly description = DESCRIPTION;
	readonly schema = ParamsSchema;

	/** Optional plan mode bindings. */
	private _planModeChecker?: () => boolean;
	private _planFilePathGetter?: () => string | null;

	/** Bind plan mode state checker and plan file path getter. */
	bindPlanMode(checker: () => boolean, pathGetter: () => string | null): void {
		this._planModeChecker = checker;
		this._planFilePathGetter = pathGetter;
	}

	async execute(params: Params, ctx: ToolContext): Promise<ToolResult> {
		if (!params.path) {
			return ToolError("File path cannot be empty.");
		}

		try {
			const resolvedPath = resolvePath(params.path, ctx.workingDir);

			// Check plan mode restrictions
			const planTarget = inspectPlanEditTarget(resolvedPath, {
				planModeChecker: this._planModeChecker ?? ctx.getPlanMode,
				planFilePathGetter: this._planFilePathGetter,
			});
			if ("isError" in planTarget && planTarget.isError) {
				return planTarget;
			}
			const isPlanFileEdit =
				!("isError" in planTarget) && planTarget.isPlanTarget;

			const file = Bun.file(resolvedPath);

			if (!(await file.exists())) {
				if (isPlanFileEdit) {
					return ToolError(
						"The current plan file does not exist yet. " +
							"Use WriteFile to create it before calling StrReplaceFile.",
					);
				}
				return ToolError(`\`${params.path}\` does not exist.`);
			}

			// Check if it's actually a file
			const { stat: fsStat } = await import("node:fs/promises");
			try {
				const info = await fsStat(resolvedPath);
				if (!info.isFile()) {
					return ToolError(`\`${params.path}\` is not a file.`);
				}
			} catch {
				// stat failed — continue
			}

			// Read the file content
			const originalContent = await file.text();
			let content = originalContent;

			const edits: Edit[] = Array.isArray(params.edit)
				? params.edit
				: [params.edit];

			// Apply all edits
			for (const edit of edits) {
				content = applyEdit(content, edit);
			}

			// Check if any changes were made
			if (content === originalContent) {
				return ToolError(
					"No replacements were made. The old string was not found in the file.",
				);
			}

			// Plan file edits are auto-approved; all other edits need approval
			if (!isPlanFileEdit) {
				// Build diff display blocks (matches Python's build_diff_blocks)
				const diffBlocks = buildWireDiffBlocks(
					resolvedPath,
					originalContent,
					content,
				);

				const { decision, feedback } = await ctx.approval(
					"StrReplaceFile",
					"edit",
					`Edit file \`${resolvedPath}\` (${edits.length} edit(s))`,
					{ display: diffBlocks },
				);
				if (decision === "reject") {
					return new ToolRejectedError({
						message: feedback
							? `The tool call is rejected by the user. User feedback: ${feedback}`
							: undefined,
						brief: feedback ? `Rejected: ${feedback}` : "Rejected by user",
						hasFeedback: !!feedback,
					}).toToolResult();
				}
			}

			// Write the modified content back
			await Bun.write(resolvedPath, content);

			// Build diff display blocks for result
			const resultDiffBlocks = buildWireDiffBlocks(
				resolvedPath,
				originalContent,
				content,
			);

			// Count changes for success message
			let totalReplacements = 0;
			for (const edit of edits) {
				if (edit.replace_all) {
					totalReplacements += originalContent.split(edit.old).length - 1;
				} else {
					totalReplacements += originalContent.includes(edit.old) ? 1 : 0;
				}
			}

			return {
				isError: false,
				output: "",
				message: `File successfully edited. Applied ${edits.length} edit(s) with ${totalReplacements} total replacement(s).`,
				display: resultDiffBlocks,
			};
		} catch (e) {
			return ToolError(`Failed to edit. Error: ${e}`);
		}
	}
}
