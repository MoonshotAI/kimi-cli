/**
 * Clipboard utilities — corresponds to Python utils/clipboard.py
 * Clipboard access for media (images, files) via system commands.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { logger } from "./logging.ts";

export interface ClipboardResult {
	readonly imagePaths: string[];
	readonly filePaths: string[];
	readonly text?: string;
}

export interface ClipboardMedia {
	images: string[]; // paths to saved image files
	files: string[]; // paths to clipboard file references
}

/**
 * Check if clipboard text access is available.
 */
export async function isClipboardAvailable(): Promise<boolean> {
	try {
		if (process.platform === "darwin") {
			const proc = Bun.spawn(["pbpaste"], { stdout: "pipe", stderr: "pipe" });
			await proc.exited;
			return true;
		}
		if (process.platform === "linux") {
			// Try xclip first, then xsel
			for (const cmd of ["xclip", "xsel"]) {
				try {
					const proc = Bun.spawn(["which", cmd], {
						stdout: "pipe",
						stderr: "pipe",
					});
					const code = await proc.exited;
					if (code === 0) return true;
				} catch {
					continue;
				}
			}
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Read text from clipboard.
 */
export async function readClipboardText(): Promise<string | undefined> {
	try {
		let proc: ReturnType<typeof Bun.spawn>;
		if (process.platform === "darwin") {
			proc = Bun.spawn(["pbpaste"], { stdout: "pipe", stderr: "pipe" });
		} else if (process.platform === "linux") {
			proc = Bun.spawn(["xclip", "-selection", "clipboard", "-o"], {
				stdout: "pipe",
				stderr: "pipe",
			});
		} else {
			return undefined;
		}
		const code = await proc.exited;
		if (code !== 0) return undefined;
		return await new Response(proc.stdout as ReadableStream).text();
	} catch {
		logger.debug("Failed to read clipboard text");
		return undefined;
	}
}

/**
 * Write text to clipboard.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
	try {
		let proc: ReturnType<typeof Bun.spawn>;
		if (process.platform === "darwin") {
			proc = Bun.spawn(["pbcopy"], {
				stdin: new Blob([text]),
				stdout: "pipe",
				stderr: "pipe",
			});
		} else if (process.platform === "linux") {
			proc = Bun.spawn(["xclip", "-selection", "clipboard"], {
				stdin: new Blob([text]),
				stdout: "pipe",
				stderr: "pipe",
			});
		} else {
			return false;
		}
		const code = await proc.exited;
		return code === 0;
	} catch {
		logger.debug("Failed to write clipboard text");
		return false;
	}
}

/**
 * Grab media (images) from the clipboard.
 * On macOS, uses osascript to check clipboard info and save image data.
 * Returns null if no image data is found or on unsupported platforms.
 */
export async function grabMediaFromClipboard(): Promise<ClipboardMedia | null> {
	// Only macOS supported for now
	if (process.platform !== "darwin") return null;

	try {
		// 1. Check clipboard content type via osascript
		const infoProc = Bun.spawn(["osascript", "-e", "clipboard info"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const info = await new Response(infoProc.stdout).text();
		await infoProc.exited;

		// 2. Check for file URLs first (Finder copy)
		const hasFileUrl = /«class furl»|public\.file-url/.test(info);
		if (hasFileUrl) {
			const fileScript = `
        try
          set theFiles to the clipboard as «class furl»
          return POSIX path of theFiles
        on error
          return ""
        end try
      `;
			const fileProc = Bun.spawn(["osascript", "-e", fileScript], {
				stdout: "pipe",
				stderr: "ignore",
			});
			const fileResult = (await new Response(fileProc.stdout).text()).trim();
			await fileProc.exited;

			if (fileResult) {
				const filePaths = fileResult
					.split("\n")
					.map((p) => p.trim())
					.filter(Boolean);
				// Classify: images vs other files
				const imageExts = new Set([
					".png",
					".jpg",
					".jpeg",
					".gif",
					".bmp",
					".tiff",
					".tif",
					".webp",
				]);
				const images: string[] = [];
				const files: string[] = [];
				for (const fp of filePaths) {
					const ext = fp.slice(fp.lastIndexOf(".")).toLowerCase();
					if (imageExts.has(ext)) {
						images.push(fp);
					} else {
						files.push(fp);
					}
				}
				if (images.length > 0 || files.length > 0) {
					return { images, files };
				}
			}
		}

		// 3. Check for raw image data (TIFF, PNG) — e.g. from screenshots
		const hasImage = /«class PNGf»|«class TIFF»|TIFF|PNG/.test(info);
		if (!hasImage) return null;

		// 4. Save clipboard image to a temp file as PNG
		const cacheDir = join(homedir(), ".kimi", "prompt-cache", "images");
		mkdirSync(cacheDir, { recursive: true });
		const filename = `clipboard-${Date.now()}.png`;
		const filepath = join(cacheDir, filename);

		const script = `
      set filePath to POSIX file "${filepath}"
      try
        set imgData to the clipboard as «class PNGf»
        set fileRef to open for access filePath with write permission
        write imgData to fileRef
        close access fileRef
        return "${filepath}"
      on error
        try
          close access filePath
        end try
        return "error"
      end try
    `;
		const saveProc = Bun.spawn(["osascript", "-e", script], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const result = (await new Response(saveProc.stdout).text()).trim();
		await saveProc.exited;

		if (result === "error" || result === "") return null;
		return { images: [filepath], files: [] };
	} catch (err) {
		logger.debug("Failed to grab media from clipboard: %s", err);
		return null;
	}
}
