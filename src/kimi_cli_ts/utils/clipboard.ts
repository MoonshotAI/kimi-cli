/**
 * Clipboard utilities — corresponds to Python utils/clipboard.py
 * Clipboard access for media (images, files) via system commands.
 */

import { logger } from "./logging.ts";

export interface ClipboardResult {
  readonly imagePaths: string[];
  readonly filePaths: string[];
  readonly text?: string;
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
          const proc = Bun.spawn(["which", cmd], { stdout: "pipe", stderr: "pipe" });
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
