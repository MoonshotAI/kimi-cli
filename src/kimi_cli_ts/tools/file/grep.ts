/**
 * Grep tool — regex search using ripgrep.
 * Corresponds to Python tools/file/grep_local.py
 *
 * Ripgrep binary resolution:
 *   1. ~/.kimi/bin/rg (cached extraction or user-installed)
 *   2. <source>/deps/bin/rg (development mode, bun run)
 *   3. System PATH (user-installed rg)
 *   4. Extract embedded binary → ~/.kimi/bin/rg (compiled mode)
 */

import { z } from "zod/v4";
import { CallableTool } from "../base.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { ToolError, ToolResultBuilder } from "../types.ts";
import {
	isSensitiveFile,
	sensitiveFileWarning,
} from "../../utils/sensitive.ts";
import { getShareDir } from "../../config.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

// Embed the ripgrep binary into compiled executable via Bun's asset system.
// In dev mode (bun run), this resolves to the file path on disk.
// In compiled mode (bun build --compile), the binary is embedded in the
// executable and this resolves to a `$bunfs/...` internal path that can be
// read with Bun.file() or fs APIs.
// @ts-ignore — import attribute not yet in TS lib
import embeddedRgPath from "../../../kimi_cli/deps/bin/rg" with {
	type: "file",
};

const RG_TIMEOUT = 20_000; // 20 seconds in ms
const RG_MAX_BUFFER = 20_000_000; // 20MB
const RG_KILL_GRACE = 5_000; // 5 seconds: SIGTERM → SIGKILL

/** Detect the ripgrep binary name for the current platform */
function getRgBinaryName(): string {
	return process.platform === "win32" ? "rg.exe" : "rg";
}

/** Check if a file exists and is executable */
function isExecutable(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Extract the embedded ripgrep binary to ~/.kimi/bin/rg.
 * Only used when running as a compiled binary (bun build --compile).
 * Reads from the Bun-embedded $bunfs/ path and writes to the cache directory.
 */
function extractEmbeddedRg(): string | null {
	try {
		const binName = getRgBinaryName();
		const targetDir = path.join(getShareDir(), "bin");
		const targetPath = path.join(targetDir, binName);

		// Read the embedded binary content
		const file = Bun.file(embeddedRgPath);
		const buffer = new Uint8Array(file.size);
		const reader = file.stream().getReader();
		let offset = 0;

		// Synchronous-ish extraction: we use a blocking pattern since this
		// only runs once on first grep invocation.
		// Use writeFileSync with the embedded path directly via fs.
		const content = fs.readFileSync(embeddedRgPath);

		// Ensure target directory exists
		fs.mkdirSync(targetDir, { recursive: true });

		// Write the binary
		fs.writeFileSync(targetPath, content);

		// Make executable (rwxr-xr-x)
		fs.chmodSync(targetPath, 0o755);

		if (isExecutable(targetPath)) {
			return targetPath;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Find the ripgrep binary using a priority-based search.
 *
 * Search order:
 *   1. ~/.kimi/bin/rg (cached extraction or user-installed)
 *   2. <source>/deps/bin/rg (development mode via bun run)
 *   3. System PATH (user-installed ripgrep)
 *   4. Extract embedded binary → ~/.kimi/bin/rg (compiled mode fallback)
 *
 * This matches the Python grep tool's search order in grep_local.py.
 */
function findRipgrepBinary(): string | null {
	const binName = getRgBinaryName();

	// Priority 1: Check user's share directory (~/.kimi/bin/rg)
	// This is the canonical cache location — both extracted and user-installed
	// binaries live here.
	const shareBin = path.join(getShareDir(), "bin", binName);
	if (fs.existsSync(shareBin) && isExecutable(shareBin)) {
		return shareBin;
	}

	// Priority 2: Check package's local deps folder (development mode)
	// This works when running with `bun run` from source tree.
	// In compiled mode, import.meta.url points to $bunfs/ — the path won't
	// resolve to a real directory, so existsSync will simply return false.
	try {
		const currentDir = path.dirname(import.meta.url.replace("file://", ""));
		const packageRoot = path.resolve(currentDir, "../../..");
		const localDep = path.join(packageRoot, "kimi_cli", "deps", "bin", binName);
		if (fs.existsSync(localDep) && isExecutable(localDep)) {
			return localDep;
		}
	} catch {
		// Not in dev mode or path resolution failed
	}

	// Priority 3: Check system PATH
	try {
		const whichCmd = process.platform === "win32" ? "where" : "which";
		const result = execSync(`${whichCmd} ${binName}`, {
			encoding: "utf-8",
		}).trim();
		if (result) {
			return result;
		}
	} catch {
		// ripgrep not found in PATH
	}

	// Priority 4: Extract embedded binary to ~/.kimi/bin/rg
	// This is the fallback for compiled mode when no cached binary exists yet.
	const extracted = extractEmbeddedRg();
	if (extracted) {
		return extracted;
	}

	return null;
}

// Cache the rg binary path
let cachedRgPath: string | null | undefined;

/** Get the ripgrep binary path, with caching */
function getRipgrepPath(): string {
	if (cachedRgPath !== undefined) {
		if (cachedRgPath === null) {
			throw new Error(
				"ripgrep (rg) not found. Install ripgrep or ensure it's in your PATH.\n" +
					"Install: https://github.com/BurntSushi/ripgrep/releases",
			);
		}
		return cachedRgPath;
	}

	const rgPath = findRipgrepBinary();
	cachedRgPath = rgPath;

	if (!rgPath) {
		throw new Error(
			"ripgrep (rg) not found. Install ripgrep or ensure it's in your PATH.\n" +
				"Install: https://github.com/BurntSushi/ripgrep/releases",
		);
	}

	return rgPath;
}

const DESCRIPTION = `A powerful search tool based on ripgrep.

**Tips:**
- ALWAYS use Grep tool instead of running \`grep\` or \`rg\` command with Shell tool.
- Use the ripgrep pattern syntax, not grep syntax. E.g. you need to escape braces like \`\\{\` to search for \`{\`.
- Hidden files (dotfiles like \`.gitlab-ci.yml\`, \`.eslintrc.json\`) are always searched. To also search files excluded by \`.gitignore\` (e.g. \`node_modules\`, build outputs), set \`include_ignored\` to \`true\`. Sensitive files (such as \`.env\`) are still skipped for safety, even when \`include_ignored\` is \`true\`.`;

const ParamsSchema = z.object({
	pattern: z
		.string()
		.describe("The regular expression pattern to search for in file contents"),
	path: z
		.string()
		.default(".")
		.describe(
			"File or directory to search in. Defaults to current working directory.",
		),
	glob: z
		.string()
		.nullish()
		.describe("Glob pattern to filter files (e.g. `*.js`, `*.{ts,tsx}`)."),
	output_mode: z
		.string()
		.default("files_with_matches")
		.describe(
			"`content`: Show matching lines; `files_with_matches`: Show file paths; `count_matches`: Show total number of matches.",
		),
	"-B": z
		.number()
		.int()
		.nullish()
		.describe("Number of lines to show before each match."),
	"-A": z
		.number()
		.int()
		.nullish()
		.describe("Number of lines to show after each match."),
	"-C": z
		.number()
		.int()
		.nullish()
		.describe("Number of lines to show before and after each match."),
	"-n": z.boolean().default(true).describe("Show line numbers in output."),
	"-i": z.boolean().default(false).describe("Case insensitive search."),
	type: z
		.string()
		.nullish()
		.describe("File type to search (e.g. py, js, ts, go, java)."),
	head_limit: z
		.number()
		.int()
		.min(0)
		.default(250)
		.describe("Limit output to first N lines/entries. 0 for unlimited."),
	offset: z
		.number()
		.int()
		.min(0)
		.default(0)
		.describe("Skip first N lines/entries before applying head_limit."),
	multiline: z
		.boolean()
		.default(false)
		.describe("Enable multiline mode where `.` matches newlines."),
	include_ignored: z
		.boolean()
		.default(false)
		.describe(
			"Include files that are ignored by `.gitignore`, `.ignore`, and other ignore " +
				"rules. Useful for searching gitignored artifacts such as build outputs " +
				"(e.g. `dist/`, `build/`) or `node_modules`. Sensitive files (like `.env`) " +
				"remain filtered by the sensitive-file protection layer. Defaults to false.",
		),
});

type Params = z.infer<typeof ParamsSchema>;

function buildRgArgs(
	params: Params,
	searchPath: string,
	rgPath: string,
	opts?: { singleThreaded?: boolean },
): string[] {
	const args: string[] = [rgPath];

	// Fixed args
	if (params.output_mode !== "content") {
		args.push("--max-columns", "500");
	}
	args.push("--hidden");
	if (params.include_ignored) {
		args.push("--no-ignore");
	}
	for (const vcsDir of [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"]) {
		args.push("--glob", `!${vcsDir}`);
	}

	if (opts?.singleThreaded) {
		args.push("-j", "1");
	}

	// Search options
	if (params["-i"]) args.push("--ignore-case");
	if (params.multiline) args.push("--multiline", "--multiline-dotall");

	// Content display options
	if (params.output_mode === "content") {
		if (params["-B"] != null)
			args.push("--before-context", String(params["-B"]));
		if (params["-A"] != null)
			args.push("--after-context", String(params["-A"]));
		if (params["-C"] != null) args.push("--context", String(params["-C"]));
		if (params["-n"]) args.push("--line-number");
	}

	// File filtering
	if (params.glob) args.push("--glob", params.glob);
	if (params.type) args.push("--type", params.type);

	// Output mode
	if (params.output_mode === "files_with_matches") {
		args.push("--files-with-matches");
	} else if (params.output_mode === "count_matches") {
		args.push("--count-matches");
	}

	// Pattern and path
	args.push("--", params.pattern, searchPath);

	return args;
}

function stripPathPrefix(output: string, searchBase: string): string {
	const prefix = searchBase.replace(/[/\\]$/, "") + "/";
	return output
		.split("\n")
		.map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
		.join("\n");
}

function isEagain(stderr: string): boolean {
	return (
		stderr.includes("os error 11") ||
		stderr.includes("Resource temporarily unavailable")
	);
}

/** Two-phase kill: SIGTERM → grace period → SIGKILL. */
async function killProcess(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
	proc.kill(); // SIGTERM
	try {
		await Promise.race([
			proc.exited,
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error("kill_grace_timeout")),
					RG_KILL_GRACE,
				),
			),
		]);
	} catch {
		// Grace period expired, send SIGKILL
		proc.kill(9);
		await proc.exited;
	}
}

export class Grep extends CallableTool<typeof ParamsSchema> {
	readonly name = "Grep";
	readonly description = DESCRIPTION;
	readonly schema = ParamsSchema;

	async execute(
		params: Params,
		ctx: ToolContext,
		opts?: { _retry?: boolean },
	): Promise<ToolResult> {
		try {
			const builder = new ToolResultBuilder();
			let message = "";

			// Resolve the search path
			let searchPath = params.path;
			if (!searchPath.startsWith("/")) {
				searchPath = `${ctx.workingDir}/${searchPath}`;
			}
			searchPath = searchPath.replace(/^~/, process.env.HOME || "");

			// Get the ripgrep binary path
			let rgPath: string;
			try {
				rgPath = getRipgrepPath();
			} catch (e) {
				// If rg is not found, try fallback to 'rg' in PATH anyway
				const err = e instanceof Error ? e.message : String(e);
				return ToolError(
					`Grep tool requires ripgrep (rg) to be installed.\n\nDetails: ${err}\n\nYou can install ripgrep with: https://github.com/BurntSushi/ripgrep/releases`,
				);
			}

			const args = buildRgArgs(params, searchPath, rgPath, {
				singleThreaded: opts?._retry,
			});

			// Execute ripgrep using Bun.spawn
			const proc = Bun.spawn(args, {
				stdout: "pipe",
				stderr: "pipe",
			});

			let timedOut = false;
			let output: string;
			let stderrStr: string;

			try {
				const timeoutPromise = new Promise<never>((_, reject) => {
					setTimeout(() => reject(new Error("timeout")), RG_TIMEOUT);
				});

				const resultPromise = (async () => {
					const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
					const stderrBytes = await new Response(proc.stderr).arrayBuffer();
					return {
						stdout: new TextDecoder().decode(stdoutBytes),
						stderr: new TextDecoder().decode(stderrBytes),
					};
				})();

				const result = await Promise.race([resultPromise, timeoutPromise]);
				output = result.stdout;
				stderrStr = result.stderr;
				await proc.exited;
			} catch (e) {
				if (e instanceof Error && e.message === "timeout") {
					await killProcess(proc);
					timedOut = true;
					output = "";
					stderrStr = "";
				} else {
					throw e;
				}
			}

			// Buffer truncation
			let bufferTruncated = false;
			if (output.length > RG_MAX_BUFFER) {
				output = output.slice(0, RG_MAX_BUFFER);
				const lastNl = output.lastIndexOf("\n");
				output = lastNl >= 0 ? output.slice(0, lastNl) : "";
				bufferTruncated = true;
				message = "Output exceeded buffer limit. Some results omitted.";
			}

			// Timeout handling
			if (timedOut) {
				if (!output.trim()) {
					return ToolError(
						`Grep timed out after ${RG_TIMEOUT / 1000}s. Try a more specific path or pattern.`,
					);
				}
				const timeoutMsg = `Grep timed out after ${RG_TIMEOUT / 1000}s. Partial results returned.`;
				message = message ? `${message} ${timeoutMsg}` : timeoutMsg;
			}

			// rg exit codes: 0=matches found, 1=no matches, 2+=error
			if (!timedOut && proc.exitCode !== 0 && proc.exitCode !== 1) {
				// EAGAIN: retry once with single-threaded mode
				if (!opts?._retry && isEagain(stderrStr)) {
					return this.execute(params, ctx, { _retry: true });
				}
				return ToolError(`Failed to grep. Error: ${stderrStr}`);
			}

			// Post-processing: strip path prefix
			let searchBase = searchPath;
			try {
				const { stat } = await import("node:fs/promises");
				const info = await stat(searchBase);
				if (info.isFile()) {
					searchBase = searchBase.replace(/\/[^/]+$/, "");
				}
			} catch {
				// path doesn't exist or inaccessible, use as-is
			}
			output = stripPathPrefix(output, searchBase);

			// Filter sensitive files from output
			const _RG_LINE_RE = /^(.*?)([:\-])(\d+)\2/;
			const outLines = output.split("\n");
			const filteredPaths: string[] = [];
			const keptLines: string[] = [];
			const sensitivePathSet = new Set<string>();

			for (const line of outLines) {
				let filePath: string;
				if (params.output_mode === "content") {
					if (line === "--") {
						keptLines.push(line);
						continue;
					}
					const m = _RG_LINE_RE.exec(line);
					filePath = m ? m[1]! : line;
				} else if (params.output_mode === "count_matches") {
					const idx = line.lastIndexOf(":");
					filePath = idx > 0 ? line.slice(0, idx) : line;
				} else {
					filePath = line;
				}

				if (filePath && isSensitiveFile(filePath)) {
					if (!sensitivePathSet.has(filePath)) {
						sensitivePathSet.add(filePath);
						filteredPaths.push(filePath);
					}
				} else {
					keptLines.push(line);
				}
			}

			if (filteredPaths.length > 0) {
				// Remove trailing "--" separators left after filtering
				while (
					keptLines.length > 0 &&
					keptLines[keptLines.length - 1] === "--"
				) {
					keptLines.pop();
				}
				output = keptLines.join("\n");
				const warning = sensitiveFileWarning(filteredPaths);
				message = message ? `${message} ${warning}` : warning;
			}

			// Split into lines
			let lines = output.split("\n");
			if (lines.length > 0 && lines[lines.length - 1] === "") {
				lines = lines.slice(0, -1);
			}

			// Sort files_with_matches by mtime (most recently modified first)
			if (
				!timedOut &&
				params.output_mode === "files_with_matches" &&
				lines.length > 0
			) {
				const { stat: fsStat } = await import("node:fs/promises");
				const withMtime = await Promise.all(
					lines.map(async (filePath) => {
						try {
							const fullPath = filePath.startsWith("/")
								? filePath
								: `${searchBase}/${filePath}`;
							const info = await fsStat(fullPath);
							return { filePath, mtime: info.mtimeMs };
						} catch {
							return { filePath, mtime: 0 };
						}
					}),
				);
				withMtime.sort((a, b) => b.mtime - a.mtime);
				lines = withMtime.map((x) => x.filePath);
			}

			// count_matches summary
			if (params.output_mode === "count_matches") {
				let totalMatches = 0;
				let totalFiles = 0;
				for (const line of lines) {
					const idx = line.lastIndexOf(":");
					if (idx > 0) {
						const count = parseInt(line.slice(idx + 1), 10);
						if (!isNaN(count)) {
							totalMatches += count;
							totalFiles += 1;
						}
					}
				}
				const countSummary = `Found ${totalMatches} total occurrences across ${totalFiles} files.`;
				message = message ? `${message} ${countSummary}` : countSummary;
			}

			// Offset + head_limit pagination
			if (params.offset > 0) {
				lines = lines.slice(params.offset);
			}

			const effectiveLimit = params.head_limit;
			if (effectiveLimit && lines.length > effectiveLimit) {
				const total = lines.length + params.offset;
				lines = lines.slice(0, effectiveLimit);
				output = lines.join("\n");
				const truncationMsg =
					`Results truncated to ${effectiveLimit} lines (total: ${total}). ` +
					`Use offset=${params.offset + effectiveLimit} to see more.`;
				message = message ? `${message} ${truncationMsg}` : truncationMsg;
			} else {
				output = lines.join("\n");
			}

			if (!output && !bufferTruncated) {
				let noMatchMsg = "No matches found";
				if (message) {
					noMatchMsg = `${noMatchMsg}. ${message}`;
				}
				return builder.ok(noMatchMsg);
			}

			builder.write(output);
			return builder.ok(message);
		} catch (e) {
			return ToolError(`Failed to grep. Error: ${String(e)}`);
		}
	}
}
