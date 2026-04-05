/**
 * ReadMediaFile tool — read images and videos.
 * Corresponds to Python tools/file/read_media.py
 */

import { resolve } from "node:path";
import { z } from "zod/v4";
import { CallableTool } from "../base.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { ToolError, ToolOk } from "../types.ts";
import { MEDIA_SNIFF_BYTES, detectFileType, type FileType } from "./utils.ts";

const MAX_MEDIA_MEGABYTES = 100;

const DESCRIPTION = `Read an image or video file from disk.

**Tips:**
- Use this tool to view images and videos directly.
- Maximum file size: ${MAX_MEDIA_MEGABYTES}MB.
- For text files, use ReadFile instead.`;

const ParamsSchema = z.object({
	path: z
		.string()
		.describe(
			"The path to the file to read. Absolute paths are required when reading files outside the working directory.",
		),
});

type Params = z.infer<typeof ParamsSchema>;

function toDataUrl(mimeType: string, data: Uint8Array): string {
	const base64 = Buffer.from(data).toString("base64");
	return `data:${mimeType};base64,${base64}`;
}

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

export class ReadMediaFile extends CallableTool<typeof ParamsSchema> {
	readonly name = "ReadMediaFile";
	readonly description = DESCRIPTION;
	readonly schema = ParamsSchema;

	async execute(params: Params, ctx: ToolContext): Promise<ToolResult> {
		if (!params.path) {
			return ToolError("File path cannot be empty.");
		}

		try {
			const resolvedPath = resolvePath(params.path, ctx.workingDir);
			const file = Bun.file(resolvedPath);

			if (!(await file.exists())) {
				return ToolError(`\`${params.path}\` does not exist.`);
			}

			const { stat: fsStat } = await import("node:fs/promises");
			const info = await fsStat(resolvedPath);
			if (!info.isFile()) {
				return ToolError(`\`${params.path}\` is not a file.`);
			}

			const size = info.size;
			if (size === 0) {
				return ToolError(`\`${params.path}\` is empty.`);
			}
			if (size > MAX_MEDIA_MEGABYTES * 1024 * 1024) {
				return ToolError(
					`\`${params.path}\` is ${size} bytes, which exceeds the max ${MAX_MEDIA_MEGABYTES}MB for media files.`,
				);
			}

			// Read header for file type detection
			const headerBuf = await file.slice(0, MEDIA_SNIFF_BYTES).arrayBuffer();
			const header = new Uint8Array(headerBuf);
			const fileType = detectFileType(resolvedPath, header);

			if (fileType.kind === "text") {
				return ToolError(
					`\`${params.path}\` is a text file. Use ReadFile to read text files.`,
				);
			}
			if (fileType.kind === "unknown") {
				return ToolError(
					`\`${params.path}\` seems not readable as an image or video file. ` +
						"You may need to read it with proper shell commands or other tools.",
				);
			}

			// Read the full file
			const data = new Uint8Array(await file.arrayBuffer());
			const dataUrl = toDataUrl(fileType.mimeType, data);

			const note =
				" If you need to output coordinates, output relative coordinates first and " +
				"compute absolute coordinates using the original image size; if you generate or " +
				"edit images/videos via commands or scripts, read the result back immediately " +
				"before continuing.";

			return ToolOk(
				dataUrl,
				`Loaded ${fileType.kind} file \`${params.path}\` (${fileType.mimeType}, ${size} bytes).${note}`,
			);
		} catch (e) {
			return ToolError(`Failed to read ${params.path}. Error: ${e}`);
		}
	}
}
