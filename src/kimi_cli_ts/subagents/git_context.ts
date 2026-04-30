/**
 * Git context collection for explore subagents — corresponds to Python subagents/git_context.py
 * Collects git repository metadata (remote URL, branch, dirty files, recent commits).
 */

import { logger } from "../utils/logging.ts";

const TIMEOUT = 5000; // ms
const MAX_DIRTY_FILES = 20;

const ALLOWED_HOSTS = [
	"github.com",
	"gitlab.com",
	"gitee.com",
	"bitbucket.org",
	"codeberg.org",
	"sr.ht",
];

export async function collectGitContext(workDir: string): Promise<string> {
	// Quick check: is this a git repo?
	if ((await runGit(["rev-parse", "--is-inside-work-tree"], workDir)) == null) {
		return "";
	}

	// Run all git commands in parallel
	const [remoteUrl, branch, dirtyRaw, logRaw] = await Promise.all([
		runGit(["remote", "get-url", "origin"], workDir),
		runGit(["branch", "--show-current"], workDir),
		runGit(["status", "--porcelain"], workDir),
		runGit(["log", "-3", "--format=%h %s"], workDir),
	]);

	const sections: string[] = [];
	sections.push(`Working directory: ${workDir}`);

	// Remote origin & project name
	if (remoteUrl) {
		const safeUrl = sanitizeRemoteUrl(remoteUrl);
		if (safeUrl) sections.push(`Remote: ${safeUrl}`);
		const project = parseProjectName(remoteUrl);
		if (project) sections.push(`Project: ${project}`);
	}

	// Current branch
	if (branch) sections.push(`Branch: ${branch}`);

	// Dirty files
	if (dirtyRaw != null) {
		const dirtyLines = dirtyRaw.split("\n").filter((l) => l.trim());
		if (dirtyLines.length > 0) {
			const total = dirtyLines.length;
			const shown = dirtyLines.slice(0, MAX_DIRTY_FILES);
			const header = `Dirty files (${total}):`;
			let body = shown.map((l) => `  ${l}`).join("\n");
			if (total > MAX_DIRTY_FILES) {
				body += `\n  ... and ${total - MAX_DIRTY_FILES} more`;
			}
			sections.push(`${header}\n${body}`);
		}
	}

	// Recent commits
	if (logRaw) {
		const logLines = logRaw.split("\n").filter((l) => l.trim());
		if (logLines.length > 0) {
			const body = logLines.map((l) => `  ${l.slice(0, 200)}`).join("\n");
			sections.push(`Recent commits:\n${body}`);
		}
	}

	if (sections.length <= 1) return "";
	const content = sections.join("\n");
	return `<git-context>\n${content}\n</git-context>`;
}

async function runGit(
	args: string[],
	cwd: string,
): Promise<string | undefined> {
	try {
		const proc = Bun.spawn(["git", "-C", cwd, ...args], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});

		const timer = setTimeout(() => proc.kill(), TIMEOUT);
		const exitCode = await proc.exited;
		clearTimeout(timer);

		if (exitCode !== 0) return undefined;
		const stdout = await new Response(proc.stdout).text();
		return stdout.trim();
	} catch {
		logger.debug(`git ${args.join(" ")} failed`);
		return undefined;
	}
}

function sanitizeRemoteUrl(remoteUrl: string): string | undefined {
	// SSH format: git@host:owner/repo.git
	for (const host of ALLOWED_HOSTS) {
		const pattern = new RegExp(`^git@${host.replace(".", "\\.")}:`);
		if (pattern.test(remoteUrl)) return remoteUrl;
	}

	// HTTPS format
	try {
		const url = new URL(remoteUrl);
		if (ALLOWED_HOSTS.includes(url.hostname)) {
			const port = url.port ? `:${url.port}` : "";
			return `https://${url.hostname}${port}${url.pathname}`;
		}
	} catch {
		// Not a valid URL
	}

	return undefined;
}

function parseProjectName(remoteUrl: string): string | undefined {
	// SSH format: git@host:owner/repo.git
	const sshMatch = remoteUrl.match(/:([^/]+\/[^/]+?)(?:\.git)?$/);
	if (sshMatch) return sshMatch[1];
	// HTTPS format: https://host/owner/repo.git
	const httpsMatch = remoteUrl.match(/\/([^/]+\/[^/]+?)(?:\.git)?$/);
	if (httpsMatch) return httpsMatch[1];
	return undefined;
}
