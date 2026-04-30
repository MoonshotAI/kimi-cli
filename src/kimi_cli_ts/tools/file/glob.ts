/**
 * Glob tool — find files and directories using glob patterns.
 * Corresponds to Python tools/file/glob.py
 */

import { z } from "zod/v4";
import { globby } from "globby";
import { CallableTool } from "../base.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { ToolError, ToolOk } from "../types.ts";

const MAX_MATCHES = 1000;

const DESCRIPTION = `Find files and directories using glob patterns. This tool supports standard glob syntax like \`*\`, \`?\`, and \`**\` for recursive searches.

**When to use:**
- Find files matching specific patterns (e.g., all Python files: \`*.py\`)
- Search for files recursively in subdirectories (e.g., \`src/**/*.js\`)
- Locate configuration files (e.g., \`*.config.*\`, \`*.json\`)

**Bad example patterns:**
- \`**\`, \`**/*.py\` - Any pattern starting with '**' will be rejected.
- \`node_modules/**/*.js\` - Avoid recursively searching in large directories.`;

const ParamsSchema = z.object({
	pattern: z.string().describe("Glob pattern to match files/directories."),
	directory: z
		.string()
		.nullish()
		.describe(
			"Absolute path to the directory to search in (defaults to working directory).",
		),
	include_dirs: z
		.boolean()
		.default(true)
		.describe("Whether to include directories in results."),
});

type Params = z.infer<typeof ParamsSchema>;

export class Glob extends CallableTool<typeof ParamsSchema> {
	readonly name = "Glob";
	readonly description = DESCRIPTION;
	readonly schema = ParamsSchema;

	async execute(params: Params, ctx: ToolContext): Promise<ToolResult> {
		try {
			// Validate pattern safety
			if (params.pattern.startsWith("**")) {
				return ToolError(
					`Pattern \`${params.pattern}\` starts with '**' which is not allowed. ` +
						"This would recursively search all directories. Use more specific patterns instead.",
				);
			}

			const dirPath = params.directory || ctx.workingDir;

			if (!dirPath.startsWith("/")) {
				return ToolError(
					`\`${params.directory}\` is not an absolute path. You must provide an absolute path to search.`,
				);
			}

			// Perform the glob search
			let matches = await globby(params.pattern, {
				cwd: dirPath,
				dot: true,
				onlyFiles: !params.include_dirs,
				ignore: [".git", ".svn", ".hg", "node_modules/**"],
			});

			// Sort for consistent output
			matches.sort();

			let message =
				matches.length > 0
					? `Found ${matches.length} matches for pattern \`${params.pattern}\`.`
					: `No matches found for pattern \`${params.pattern}\`.`;

			if (matches.length > MAX_MATCHES) {
				matches = matches.slice(0, MAX_MATCHES);
				message += ` Only the first ${MAX_MATCHES} matches are returned. You may want to use a more specific pattern.`;
			}

			return ToolOk(matches.join("\n"), message);
		} catch (e) {
			return ToolError(
				`Failed to search for pattern ${params.pattern}. Error: ${e}`,
			);
		}
	}
}
