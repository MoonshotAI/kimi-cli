/**
 * ReadFile tool — read text content from a file.
 * Corresponds to Python tools/file/read.py
 */

import { z } from "zod/v4";
import { CallableTool } from "../base.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { ToolError, ToolOk } from "../types.ts";
import { isSensitiveFile } from "../../utils/sensitive.ts";

const MAX_LINES = 1000;
const MAX_LINE_LENGTH = 2000;
const MAX_BYTES = 100 * 1024; // 100KB

const DESCRIPTION = `Read text content from a file.

**Tips:**
- A \`<system>\` tag will be given before the read file content.
- This tool can only read text files.
- Content will be returned with a line number before each line like \`cat -n\` format.
- Use \`line_offset\` and \`n_lines\` parameters when you only need to read a part of the file.
- Use negative \`line_offset\` to read from the end of the file (e.g. \`line_offset=-100\` reads the last 100 lines). This is useful for viewing the tail of log files. The absolute value cannot exceed ${MAX_LINES}.
- The tool always returns the total number of lines in the file in its message, which you can use to plan subsequent reads.
- The maximum number of lines that can be read at once is ${MAX_LINES}.
- Any lines longer than ${MAX_LINE_LENGTH} characters will be truncated, ending with "...".`;

const ParamsSchema = z.object({
	path: z
		.string()
		.describe(
			"The path to the file to read. Absolute paths are required when reading files outside the working directory.",
		),
	line_offset: z
		.number()
		.int()
		.default(1)
		.describe(
			"The line number to start reading from. By default read from the beginning of the file. " +
				"Set this when the file is too large to read at once. " +
				"Negative values read from the end of the file (e.g. -100 reads the last 100 lines). " +
				`The absolute value of negative offset cannot exceed ${MAX_LINES}.`,
		),
	n_lines: z
		.number()
		.int()
		.min(1)
		.default(MAX_LINES)
		.describe(
			`The number of lines to read. Defaults to ${MAX_LINES} (max allowed).`,
		),
});

type Params = z.infer<typeof ParamsSchema>;

function truncateLine(line: string, maxLength: number): string {
	if (line.length <= maxLength) return line;
	return line.slice(0, maxLength - 3) + "...";
}

function resolvePath(filePath: string, workingDir: string): string {
	if (filePath.startsWith("/") || filePath.startsWith("~")) {
		if (filePath.startsWith("~")) {
			const home = process.env.HOME || process.env.USERPROFILE || "";
			return filePath.replace(/^~/, home);
		}
		return filePath;
	}
	return `${workingDir}/${filePath}`;
}

// ── Binary file detection ─────────────────────────────
// Magic byte signatures for common binary formats

const BINARY_SIGNATURES: Array<{ bytes: number[]; type: string }> = [
	{ bytes: [0x89, 0x50, 0x4e, 0x47], type: "PNG image" },
	{ bytes: [0xff, 0xd8, 0xff], type: "JPEG image" },
	{ bytes: [0x47, 0x49, 0x46, 0x38], type: "GIF image" },
	{ bytes: [0x52, 0x49, 0x46, 0x46], type: "RIFF (WebP/AVI)" },
	{ bytes: [0x50, 0x4b, 0x03, 0x04], type: "ZIP archive" },
	{ bytes: [0x1f, 0x8b], type: "gzip archive" },
	{ bytes: [0x25, 0x50, 0x44, 0x46], type: "PDF document" },
	{ bytes: [0x7f, 0x45, 0x4c, 0x46], type: "ELF binary" },
	{ bytes: [0xfe, 0xed, 0xfa, 0xce], type: "Mach-O binary" },
	{ bytes: [0xfe, 0xed, 0xfa, 0xcf], type: "Mach-O binary (64-bit)" },
	{ bytes: [0xce, 0xfa, 0xed, 0xfe], type: "Mach-O binary (reverse)" },
	{ bytes: [0xcf, 0xfa, 0xed, 0xfe], type: "Mach-O binary (64-bit reverse)" },
	{ bytes: [0xca, 0xfe, 0xba, 0xbe], type: "Mach-O universal binary" },
	{ bytes: [0x4d, 0x5a], type: "Windows executable" },
];

const NON_TEXT_EXTENSIONS = new Set([
	// Images
	"png",
	"jpg",
	"jpeg",
	"gif",
	"bmp",
	"ico",
	"webp",
	"svg",
	"tiff",
	"tif",
	"avif",
	"heic",
	"heif",
	// Video
	"mp4",
	"mkv",
	"avi",
	"mov",
	"wmv",
	"flv",
	"webm",
	"m4v",
	"3gp",
	// Audio
	"mp3",
	"wav",
	"ogg",
	"flac",
	"aac",
	"wma",
	"m4a",
	"opus",
	// Archives
	"zip",
	"tar",
	"gz",
	"bz2",
	"xz",
	"7z",
	"rar",
	"zst",
	// Binaries
	"exe",
	"dll",
	"so",
	"dylib",
	"o",
	"a",
	"lib",
	"bin",
	"dat",
	// Documents (binary)
	"pdf",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"ppt",
	"pptx",
	// Database
	"db",
	"sqlite",
	"sqlite3",
	// Fonts
	"ttf",
	"otf",
	"woff",
	"woff2",
	"eot",
	// Other
	"pyc",
	"pyo",
	"class",
	"jar",
	"war",
	"deb",
	"rpm",
	"dmg",
	"iso",
	"img",
]);

function detectBinaryType(
	resolvedPath: string,
	headerBytes: Uint8Array,
): string | null {
	// Check magic bytes
	for (const sig of BINARY_SIGNATURES) {
		if (sig.bytes.every((b, i) => headerBytes[i] === b)) {
			return sig.type;
		}
	}

	// Check for NUL bytes in first 8KB (strong binary indicator)
	for (let i = 0; i < Math.min(headerBytes.length, 8192); i++) {
		if (headerBytes[i] === 0x00) {
			return "binary file (contains NUL bytes)";
		}
	}

	// Check extension
	const ext = resolvedPath.split(".").pop()?.toLowerCase() ?? "";
	if (NON_TEXT_EXTENSIONS.has(ext)) {
		return `binary file (.${ext})`;
	}

	return null;
}

export class ReadFile extends CallableTool<typeof ParamsSchema> {
	readonly name = "ReadFile";
	readonly description = DESCRIPTION;
	readonly schema = ParamsSchema;

	async execute(params: Params, ctx: ToolContext): Promise<ToolResult> {
		if (!params.path) {
			return ToolError("File path cannot be empty.");
		}

		// Validate line_offset
		if (params.line_offset === 0) {
			return ToolError(
				"line_offset cannot be 0; use 1 for the first line or -1 for the last line.",
			);
		}
		if (params.line_offset < -MAX_LINES) {
			return ToolError(
				`line_offset cannot be less than -${MAX_LINES}. ` +
					"Use a positive line_offset with the total line count to read from a specific position.",
			);
		}

		try {
			const resolvedPath = resolvePath(params.path, ctx.workingDir);

			if (isSensitiveFile(resolvedPath)) {
				return ToolError(
					`\`${params.path}\` appears to contain secrets ` +
						"(matched sensitive file pattern). " +
						"Reading this file is blocked to protect credentials.",
				);
			}

			const file = Bun.file(resolvedPath);

			if (!(await file.exists())) {
				return ToolError(`\`${params.path}\` does not exist.`);
			}

			// Check if it's a directory
			const { stat } = await import("node:fs/promises");
			try {
				const info = await stat(resolvedPath);
				if (info.isDirectory()) {
					return ToolError(
						`\`${params.path}\` is a directory, not a file. Use the Glob tool to list directory contents.`,
					);
				}
			} catch {
				// stat failed — continue, file.text() will catch it
			}

			// Binary detection: read header bytes first
			const headerSize = Math.min(file.size, 8192);
			if (headerSize > 0) {
				const headerBuf = await file.slice(0, headerSize).arrayBuffer();
				const headerBytes = new Uint8Array(headerBuf);
				const binaryType = detectBinaryType(resolvedPath, headerBytes);
				if (binaryType) {
					return ToolError(
						`\`${params.path}\` is a ${binaryType}. This tool can only read text files. ` +
							`Use the Shell tool if you need to inspect binary files (e.g. \`file\`, \`hexdump\`).`,
					);
				}
			}

			// Read file content
			const text = await file.text();
			const allLines = text.split("\n");
			// Handle trailing newline: if file ends with \n, last element is empty string — not a real line
			const totalLines = text.endsWith("\n")
				? allLines.length - 1
				: allLines.length;
			// Special case: empty file
			if (text === "") {
				return ToolOk(
					"",
					`No lines read from file. Total lines in file: 0. End of file reached.`,
				);
			}

			if (params.line_offset < 0) {
				return this._readTail(allLines, totalLines, text, params);
			} else {
				return this._readForward(allLines, totalLines, text, params);
			}
		} catch (e) {
			return ToolError(`Failed to read ${params.path}. Error: ${e}`);
		}
	}

	private _readForward(
		allLines: string[],
		totalLines: number,
		text: string,
		params: Params,
	): ToolResult {
		const lineOffset = params.line_offset;
		const nLines = params.n_lines;

		const lines: string[] = [];
		const truncatedLineNumbers: number[] = [];
		let nBytes = 0;
		let maxLinesReached = false;
		let maxBytesReached = false;

		for (let i = lineOffset - 1; i < totalLines && lines.length < nLines; i++) {
			const lineNo = i + 1;
			let line = allLines[i] ?? "";
			// Add newline back except for last line if original doesn't end with \n
			if (i < allLines.length - 1 || text.endsWith("\n")) {
				line += "\n";
			}

			const truncated = truncateLine(line, MAX_LINE_LENGTH);
			if (truncated !== line) {
				truncatedLineNumbers.push(lineNo);
			}
			lines.push(truncated);
			nBytes += new TextEncoder().encode(truncated).length;

			if (lines.length >= MAX_LINES) {
				maxLinesReached = true;
				break;
			}
			if (nBytes >= MAX_BYTES) {
				maxBytesReached = true;
				break;
			}
		}

		// Format output with line numbers (cat -n format)
		const linesWithNo = lines.map((line: string, idx: number) => {
			const lineNum = lineOffset + idx;
			return `${String(lineNum).padStart(6)}\t${line}`;
		});

		let message =
			lines.length > 0
				? `${lines.length} lines read from file starting from line ${lineOffset}.`
				: "No lines read from file.";

		message += ` Total lines in file: ${totalLines}.`;

		if (maxLinesReached) {
			message += ` Max ${MAX_LINES} lines reached.`;
		} else if (maxBytesReached) {
			message += ` Max ${MAX_BYTES} bytes reached.`;
		} else if (lines.length < nLines) {
			message += " End of file reached.";
		}
		if (truncatedLineNumbers.length > 0) {
			message += ` Lines [${truncatedLineNumbers.join(", ")}] were truncated.`;
		}

		return ToolOk(linesWithNo.join(""), message);
	}

	private _readTail(
		allLines: string[],
		totalLines: number,
		text: string,
		params: Params,
	): ToolResult {
		const tailCount = Math.abs(params.line_offset);

		// Get the last tailCount lines (using a slice of allLines, 0-indexed)
		const startIdx = Math.max(0, totalLines - tailCount);
		const tailEntries: Array<{
			lineNo: number;
			line: string;
			wasTruncated: boolean;
		}> = [];

		for (let i = startIdx; i < totalLines; i++) {
			let line = allLines[i] ?? "";
			if (i < allLines.length - 1 || text.endsWith("\n")) {
				line += "\n";
			}
			const truncated = truncateLine(line, MAX_LINE_LENGTH);
			tailEntries.push({
				lineNo: i + 1,
				line: truncated,
				wasTruncated: truncated !== line,
			});
		}

		// Apply n_lines / MAX_LINES limit from head of tail entries
		const lineLimit = Math.min(params.n_lines, MAX_LINES);
		let candidates = tailEntries.slice(0, lineLimit);
		const maxLinesReached =
			tailEntries.length > MAX_LINES && candidates.length === MAX_LINES;

		// Apply MAX_BYTES — if candidates exceed byte budget, reverse-scan to keep newest lines
		const totalCandidateBytes = candidates.reduce(
			(sum, e) => sum + new TextEncoder().encode(e.line).length,
			0,
		);
		let maxBytesReached = false;
		if (totalCandidateBytes > MAX_BYTES) {
			maxBytesReached = true;
			let kept = 0;
			let nBytes = 0;
			for (let i = candidates.length - 1; i >= 0; i--) {
				nBytes += new TextEncoder().encode(candidates[i]!.line).length;
				if (nBytes > MAX_BYTES) break;
				kept++;
			}
			candidates = candidates.slice(candidates.length - kept);
		}

		// Collect results
		const truncatedLineNumbers: number[] = [];
		const lineNumbers: number[] = [];
		const lines: string[] = [];

		for (const entry of candidates) {
			if (entry.wasTruncated) truncatedLineNumbers.push(entry.lineNo);
			lines.push(entry.line);
			lineNumbers.push(entry.lineNo);
		}

		// Format output with absolute line numbers
		const linesWithNo = lines.map((line: string, idx: number) => {
			return `${String(lineNumbers[idx]).padStart(6)}\t${line}`;
		});

		const startLine = lineNumbers.length > 0 ? lineNumbers[0] : totalLines + 1;
		let message =
			lines.length > 0
				? `${lines.length} lines read from file starting from line ${startLine}.`
				: "No lines read from file.";

		message += ` Total lines in file: ${totalLines}.`;

		if (maxLinesReached) {
			message += ` Max ${MAX_LINES} lines reached.`;
		} else if (maxBytesReached) {
			message += ` Max ${MAX_BYTES} bytes reached.`;
		} else if (lines.length < params.n_lines) {
			message += " End of file reached.";
		}
		if (truncatedLineNumbers.length > 0) {
			message += ` Lines [${truncatedLineNumbers.join(", ")}] were truncated.`;
		}

		return ToolOk(linesWithNo.join(""), message);
	}
}
