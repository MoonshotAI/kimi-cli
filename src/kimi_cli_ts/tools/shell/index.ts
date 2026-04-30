/**
 * Shell tool — execute shell commands.
 * Corresponds to Python tools/shell/__init__.py
 */

import { z } from "zod/v4";
import { CallableTool } from "../base.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { ToolError, ToolRejectedError, ToolResultBuilder } from "../types.ts";

const MAX_FOREGROUND_TIMEOUT = 5 * 60; // 5 minutes
const MAX_BACKGROUND_TIMEOUT = 24 * 60 * 60; // 24 hours

const DESCRIPTION = `Execute a shell command. Use this tool to explore the filesystem, edit files, run scripts, get system information, etc.

**Output:**
The stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long.

**Guidelines for safety and security:**
- Each shell tool call will be executed in a fresh shell environment.
- Avoid using \`..\ to access files outside of the working directory.
- Never run commands that require superuser privileges unless explicitly instructed.

**Guidelines for efficiency:**
- For multiple related commands, use \`&&\` to chain them in a single call.
- Prefer \`run_in_background=true\` for long-running builds, tests, or servers.`;

const ParamsSchema = z
	.object({
		command: z.string().describe("The command to execute."),
		timeout: z
			.number()
			.int()
			.min(1)
			.max(MAX_BACKGROUND_TIMEOUT)
			.default(60)
			.describe("The timeout in seconds for the command to execute."),
		run_in_background: z
			.boolean()
			.default(false)
			.describe("Whether to run the command as a background task."),
		description: z
			.string()
			.default("")
			.describe(
				"A short description for the background task. Required when run_in_background=true.",
			),
	})
	.refine(
		(data) => !data.run_in_background || data.description.trim().length > 0,
		{
			message: "description is required when run_in_background is true",
			path: ["description"],
		},
	)
	.refine(
		(data) => data.run_in_background || data.timeout <= MAX_FOREGROUND_TIMEOUT,
		{
			message: `timeout must be <= ${MAX_FOREGROUND_TIMEOUT}s for foreground commands; use run_in_background=true for longer timeouts`,
			path: ["timeout"],
		},
	);

type Params = z.infer<typeof ParamsSchema>;

/** Build a non-interactive environment to prevent prompts from hanging. */
function getNoninteractiveEnv(): Record<string, string> {
	return {
		...process.env,
		GIT_TERMINAL_PROMPT: "0",
		TERM: "dumb",
		// Prevent SSH from trying to open a tty for passphrase/password
		SSH_ASKPASS: "",
		SSH_ASKPASS_REQUIRE: "never",
		// Prevent GPG pinentry
		GPG_TTY: "",
		// Disable pager for git, man, etc.
		GIT_PAGER: "cat",
		PAGER: "cat",
		// Disable color in common tools (helps with output parsing)
		NO_COLOR: "1",
	};
}

/** Read a stream and write chunks to builder, interleaving stdout and stderr. */
async function readStreamToBuilder(
	stream: ReadableStream<Uint8Array> | null,
	builder: ToolResultBuilder,
): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: false });
	const chunks: string[] = [];
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const text = decoder.decode(value, { stream: true });
			chunks.push(text);
			builder.write(text);
		}
	} finally {
		reader.releaseLock();
	}
	return chunks.join("");
}

export class Shell extends CallableTool<typeof ParamsSchema> {
	readonly name = "Shell";
	readonly description = DESCRIPTION;
	readonly schema = ParamsSchema;

	async execute(params: Params, ctx: ToolContext): Promise<ToolResult> {
		const builder = new ToolResultBuilder();

		if (!params.command) {
			return builder.error("Command cannot be empty.");
		}

		if (params.run_in_background) {
			// Background mode - stub for now
			return builder.error(
				"Background tasks are not yet implemented in this version.",
			);
		}

		// Request approval
		const { decision, feedback } = await ctx.approval(
			"Shell",
			"run command",
			`Run command \`${params.command}\``,
			{
				display: [
					{
						type: "shell" as const,
						language: "bash",
						command: params.command,
					},
				],
			},
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

		try {
			const shellPath = process.env.SHELL || "/bin/bash";

			// Redirect stderr to stdout so they're interleaved in order
			// Use shell syntax: command 2>&1
			const wrappedCommand = `${params.command} 2>&1`;

			const proc = Bun.spawn([shellPath, "-c", wrappedCommand], {
				stdout: "pipe",
				stderr: "pipe", // stderr still piped for safety (but most goes to stdout via 2>&1)
				stdin: "pipe",
				cwd: ctx.workingDir,
				env: getNoninteractiveEnv(),
			});

			// Close stdin immediately so interactive prompts get EOF
			try {
				proc.stdin.end();
			} catch {
				// Bun may not support .end() on all platforms
			}

			let timedOut = false;
			let timeoutId: ReturnType<typeof setTimeout> | null = null;

			try {
				const timeoutPromise = new Promise<never>((_, reject) => {
					timeoutId = setTimeout(
						() => reject(new Error("timeout")),
						params.timeout * 1000,
					);
				});

				// Stream stdout to builder for real-time interleaved output
				const readPromise = (async () => {
					await readStreamToBuilder(
						proc.stdout as ReadableStream<Uint8Array>,
						builder,
					);
					// Also drain stderr (in case anything bypassed 2>&1)
					const stderrBytes = await new Response(proc.stderr).arrayBuffer();
					const stderrStr = new TextDecoder("utf-8", { fatal: false }).decode(
						stderrBytes,
					);
					if (stderrStr) builder.write(stderrStr);
				})();

				await Promise.race([readPromise, timeoutPromise]);
				if (timeoutId !== null) clearTimeout(timeoutId);

				await proc.exited;
			} catch (e) {
				if (timeoutId !== null) clearTimeout(timeoutId);
				if (e instanceof Error && e.message === "timeout") {
					proc.kill();
					timedOut = true;
				} else {
					throw e;
				}
			}

			if (timedOut) {
				return builder.error(`Command killed by timeout (${params.timeout}s)`);
			}

			const exitCode = proc.exitCode;
			if (exitCode === 0) {
				return builder.ok("Command executed successfully.");
			}
			return builder.error(`Command failed with exit code: ${exitCode}.`);
		} catch (e) {
			return builder.error(`Failed to execute command. Error: ${e}`);
		}
	}
}
