/**
 * shell-executor.ts — Shell and editor command execution.
 *
 * - runShellCommand: spawns a shell subprocess
 * - openExternalEditor: opens $EDITOR and returns content
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run a shell command in a subprocess. */
export async function runShellCommand(
	command: string,
	notify: (title: string, body: string) => void,
): Promise<void> {
	const trimmed = command.trim();
	if (!trimmed) return;
	if (trimmed.split(/\s+/)[0] === "cd") {
		notify("Shell", "Warning: Directory changes are not preserved.");
		return;
	}
	try {
		const proc = Bun.spawn(["sh", "-c", trimmed], {
			stdio: ["inherit", "inherit", "inherit"],
			env: process.env,
		});
		await proc.exited;
	} catch (err: any) {
		notify("Shell", `Failed: ${err?.message ?? err}`);
	}
}

/** Open an external editor, return submitted text via callback. */
export async function openExternalEditor(
	notify: (title: string, body: string) => void,
	onSubmit?: (input: string) => void,
): Promise<void> {
	const editor = process.env.VISUAL || process.env.EDITOR || "vim";
	const tmpFile = join(tmpdir(), `kimi-input-${Date.now()}.md`);
	try {
		await Bun.write(tmpFile, "");
		const proc = Bun.spawn(editor.split(/\s+/).concat(tmpFile), {
			stdio: ["inherit", "inherit", "inherit"],
		});
		if ((await proc.exited) !== 0) {
			notify("Editor", "Editor exited with error");
			return;
		}
		const content = (await Bun.file(tmpFile).text()).trim();
		if (content && onSubmit) onSubmit(content);
		else if (!content) notify("Editor", "Empty input, nothing submitted.");
	} catch (err: any) {
		notify("Editor", `Failed: ${err?.message ?? err}`);
	} finally {
		try {
			require("node:fs").unlinkSync(tmpFile);
		} catch {
			/* ignore */
		}
	}
}
