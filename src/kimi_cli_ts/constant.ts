/**
 * Constants module — corresponds to Python constant.py
 * Exports NAME, VERSION, USER_AGENT, and helper functions.
 */

import { join } from "node:path";

export const NAME = "Kimi Code CLI";

let _version: string | null = null;

export function getVersion(): string {
	if (_version) return _version;
	try {
		// Read version from package.json at build/runtime
		const pkgPath = join(import.meta.dir, "../../package.json");
		const pkg = require(pkgPath);
		_version = String(pkg.version ?? "0.0.0");
	} catch {
		_version = "0.0.0";
	}
	return _version;
}

export function getUserAgent(): string {
	return `KimiCLI/${getVersion()}`;
}

export const VERSION: string = getVersion();
export const USER_AGENT: string = getUserAgent();
