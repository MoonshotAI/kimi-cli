/**
 * /add-dir slash command handler.
 * Adds a directory to the workspace scope.
 * Corresponds to Python soul/slash.py add_dir command.
 */

import { resolve } from "node:path";
import type { Session } from "../../../session.ts";
import { saveSessionState } from "../../../session.ts";

export async function handleAddDir(
	session: Session,
	workDir: string,
	args: string,
): Promise<string> {
	const arg = args.trim();

	// No args: list currently added directories
	if (!arg) {
		const dirs = session.state.additional_dirs;
		if (!dirs.length) {
			return "No additional directories. Usage: /add-dir <path>";
		}
		const lines = ["Additional directories:"];
		for (const d of dirs) {
			lines.push(`  - ${d}`);
		}
		return lines.join("\n");
	}

	// Resolve the path
	const dirPath = resolve(arg.replace(/^~/, process.env.HOME ?? "~"));

	// Check existence
	const dirFile = Bun.file(dirPath);
	try {
		const stat = await Bun.$`test -d ${dirPath}`.quiet();
		if (stat.exitCode !== 0) {
			return `Not a directory: ${dirPath}`;
		}
	} catch {
		return `Directory does not exist: ${dirPath}`;
	}

	// Check if already added
	if (session.state.additional_dirs.includes(dirPath)) {
		return `Directory already in workspace: ${dirPath}`;
	}

	// Check if within work dir
	if (dirPath.startsWith(workDir + "/") || dirPath === workDir) {
		return `Directory is already within the working directory: ${dirPath}`;
	}

	// Check if within an already-added directory
	for (const existing of session.state.additional_dirs) {
		if (dirPath.startsWith(existing + "/") || dirPath === existing) {
			return `Directory is already within added directory ${existing}: ${dirPath}`;
		}
	}

	// Validate readability
	let lsOutput = "";
	try {
		lsOutput = await Bun.$`ls -la ${dirPath}`.quiet().text();
	} catch (e) {
		return `Cannot read directory: ${dirPath}`;
	}

	// Add the directory
	session.state.additional_dirs.push(dirPath);
	await saveSessionState(session.state, session.dir);

	return `Added directory to workspace: ${dirPath}`;
}
