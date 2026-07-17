/**
 * Environment detection — corresponds to Python utils/environment.py
 * Detects OS, architecture, and default shell.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export type OsKind = "macOS" | "Windows" | "Linux" | string;
export type ShellName = "bash" | "sh" | "Windows PowerShell";

export interface Environment {
	readonly osKind: OsKind;
	readonly osArch: string;
	readonly osVersion: string;
	readonly shellName: ShellName;
	readonly shellPath: string;
}

/**
 * Detect the current environment: OS, architecture, and default shell.
 */
export async function detectEnvironment(): Promise<Environment> {
	let osKind: OsKind;
	switch (process.platform) {
		case "darwin":
			osKind = "macOS";
			break;
		case "win32":
			osKind = "Windows";
			break;
		case "linux":
			osKind = "Linux";
			break;
		default:
			osKind = process.platform;
	}

	const osArch = process.arch;

	// Get OS version
	let osVersion = "";
	try {
		const { release } = await import("node:os");
		osVersion = release();
	} catch {
		// Ignore
	}

	let shellName: ShellName;
	let shellPath: string;

	if (osKind === "Windows") {
		shellName = "Windows PowerShell";
		const systemRoot = process.env.SYSTEMROOT ?? "C:\\Windows";
		const possiblePaths = [
			join(
				systemRoot,
				"System32",
				"WindowsPowerShell",
				"v1.0",
				"powershell.exe",
			),
		];
		const fallbackPath = "powershell.exe";
		let foundWindows = false;
		for (const p of possiblePaths) {
			if (existsSync(p)) {
				shellPath = p;
				foundWindows = true;
				break;
			}
		}
		if (!foundWindows) {
			shellPath = fallbackPath;
		}
	} else {
		const bashPaths = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"];
		let found = false;
		for (const p of bashPaths) {
			if (existsSync(p)) {
				shellName = "bash";
				shellPath = p;
				found = true;
				break;
			}
		}
		if (!found) {
			shellName = "sh";
			shellPath = "/bin/sh";
		}
	}

	return {
		osKind,
		osArch,
		osVersion,
		shellName: shellName!,
		shellPath: shellPath!,
	};
}
