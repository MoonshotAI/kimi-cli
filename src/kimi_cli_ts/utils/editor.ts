/**
 * External editor utilities — corresponds to Python utils/editor.py
 * Opens text in $VISUAL/$EDITOR for editing.
 */

import { statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "./logging.ts";
import { getCleanEnv } from "./subprocess_env.ts";

/** VSCode needs --wait to block until the file is closed. */
const EDITOR_CANDIDATES: Array<[string[], string]> = [
	[["code", "--wait"], "code"],
	[["vim"], "vim"],
	[["vi"], "vi"],
	[["nano"], "nano"],
];

/**
 * Determine the editor command to use.
 *
 * Priority: configured (from config) -> $VISUAL -> $EDITOR -> auto-detect.
 * Auto-detect order: code --wait -> vim -> vi -> nano.
 */
export function getEditorCommand(configured = ""): string[] | null {
	if (configured) {
		return configured.split(/\s+/).filter(Boolean);
	}

	for (const varName of ["VISUAL", "EDITOR"]) {
		const value = process.env[varName];
		if (value) {
			return value.split(/\s+/).filter(Boolean);
		}
	}

	for (const [cmd, binary] of EDITOR_CANDIDATES) {
		if (Bun.which(binary) !== null) {
			return cmd;
		}
	}

	return null;
}

/**
 * Open text in an external editor and return the edited result.
 * Returns null if the editor failed or the user quit without saving.
 */
export async function editTextInEditor(
	text: string,
	configured = "",
): Promise<string | null> {
	const editorCmd = getEditorCommand(configured);
	if (editorCmd === null) {
		logger.warn("No editor found. Set $VISUAL or $EDITOR.");
		return null;
	}

	const tmpFile = join(
		tmpdir(),
		`kimi-edit-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
	);
	try {
		await Bun.write(tmpFile, text);
		const mtimeBefore = statSync(tmpFile).mtimeMs;

		const proc = Bun.spawn([...editorCmd, tmpFile], {
			env: getCleanEnv(),
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			logger.warn(`Editor exited with non-zero return code: ${exitCode}`);
			return null;
		}

		const mtimeAfter = statSync(tmpFile).mtimeMs;
		if (mtimeAfter === mtimeBefore) {
			return null;
		}

		let edited = await Bun.file(tmpFile).text();
		if (edited.endsWith("\n")) {
			edited = edited.slice(0, -1);
		}

		return edited;
	} catch (err) {
		logger.warn(`Failed to launch editor ${editorCmd}: ${err}`);
		return null;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			// Ignore cleanup errors
		}
	}
}
