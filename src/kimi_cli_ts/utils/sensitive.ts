/**
 * Sensitive file detection — blocks access to files containing secrets.
 * Corresponds to Python utils/sensitive.py
 */

// High-confidence sensitive file patterns.
// Only patterns with very low false-positive risk are included.
const SENSITIVE_PATTERNS: string[] = [
	// Environment variable / secrets
	".env",
	".env.*",
	// SSH private keys
	"id_rsa",
	"id_ed25519",
	"id_ecdsa",
	// Cloud credentials (path-based, also bare name for stripped-path scenarios)
	".aws/credentials",
	".gcp/credentials",
	"credentials",
];

// Template/example files that match .env.* but are not sensitive.
const SENSITIVE_EXEMPTIONS = new Set([
	".env.example",
	".env.sample",
	".env.template",
]);

/**
 * Simple fnmatch-style matching (supports * and ? wildcards).
 */
function fnmatch(name: string, pattern: string): boolean {
	// Convert fnmatch pattern to regex
	let regex = "^";
	for (const ch of pattern) {
		if (ch === "*") regex += ".*";
		else if (ch === "?") regex += ".";
		else if (".+^${}()|[]\\".includes(ch)) regex += "\\" + ch;
		else regex += ch;
	}
	regex += "$";
	return new RegExp(regex).test(name);
}

/**
 * Check if a file path matches any sensitive file pattern.
 */
export function isSensitiveFile(path: string): boolean {
	// Extract basename
	const parts = path.replace(/\\/g, "/").split("/");
	const name = parts[parts.length - 1] || "";

	if (SENSITIVE_EXEMPTIONS.has(name)) {
		return false;
	}

	for (const pattern of SENSITIVE_PATTERNS) {
		if (pattern.includes("/")) {
			if (path.endsWith(pattern) || path.includes("/" + pattern)) {
				return true;
			}
		} else {
			if (fnmatch(name, pattern)) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Generate a warning message for sensitive files that were skipped.
 */
export function sensitiveFileWarning(paths: string[]): string {
	const nameSet = new Set<string>();
	for (const p of paths) {
		const parts = p.replace(/\\/g, "/").split("/");
		nameSet.add(parts[parts.length - 1] || p);
	}
	const names = [...nameSet].sort();
	let fileList = names.slice(0, 5).join(", ");
	if (names.length > 5) {
		fileList += `, ... (${names.length} files total)`;
	}
	return (
		`Skipped ${paths.length} sensitive file(s) (${fileList}) ` +
		`to protect secrets. These files may contain credentials or private keys.`
	);
}
