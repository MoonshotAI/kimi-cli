/**
 * useGitStatus hook — periodically fetches git branch and status info.
 * Matches Python's _get_git_branch / _get_git_status in prompt.py.
 *
 * - Branch refreshes every 5s
 * - Status (dirty/ahead/behind) refreshes every 15s
 */

import { useState, useEffect, useRef } from "react";

const BRANCH_TTL_MS = 5_000;
const STATUS_TTL_MS = 15_000;

export interface GitStatus {
	branch: string | null;
	dirty: boolean;
	ahead: number;
	behind: number;
}

async function execQuiet(cmd: string[]): Promise<string> {
	try {
		const proc = Bun.spawn(cmd, {
			stdout: "pipe",
			stderr: "ignore",
			cwd: process.cwd(),
		});
		const text = await new Response(proc.stdout).text();
		const code = await proc.exited;
		return code === 0 ? text.trim() : "";
	} catch {
		return "";
	}
}

async function fetchBranch(): Promise<string | null> {
	const result = await execQuiet(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
	return result || null;
}

async function fetchStatus(): Promise<{
	dirty: boolean;
	ahead: number;
	behind: number;
}> {
	// Porcelain status for dirty check
	const porcelain = await execQuiet(["git", "status", "--porcelain", "-uno"]);
	const dirty = porcelain.length > 0;

	// Ahead/behind from rev-list
	let ahead = 0;
	let behind = 0;
	const upstream = await execQuiet([
		"git",
		"rev-parse",
		"--abbrev-ref",
		"@{u}",
	]);
	if (upstream) {
		const aheadStr = await execQuiet([
			"git",
			"rev-list",
			"--count",
			`${upstream}..HEAD`,
		]);
		const behindStr = await execQuiet([
			"git",
			"rev-list",
			"--count",
			`HEAD..${upstream}`,
		]);
		ahead = parseInt(aheadStr, 10) || 0;
		behind = parseInt(behindStr, 10) || 0;
	}

	return { dirty, ahead, behind };
}

export function useGitStatus(): GitStatus {
	const [branch, setBranch] = useState<string | null>(null);
	const [dirty, setDirty] = useState(false);
	const [ahead, setAhead] = useState(0);
	const [behind, setBehind] = useState(0);
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;

		// Initial fetch
		fetchBranch().then((b) => {
			if (mountedRef.current) setBranch(b);
		});
		fetchStatus().then((s) => {
			if (!mountedRef.current) return;
			setDirty(s.dirty);
			setAhead(s.ahead);
			setBehind(s.behind);
		});

		// Periodic refresh
		const branchTimer = setInterval(() => {
			fetchBranch().then((b) => {
				if (mountedRef.current) setBranch(b);
			});
		}, BRANCH_TTL_MS);

		const statusTimer = setInterval(() => {
			fetchStatus().then((s) => {
				if (!mountedRef.current) return;
				setDirty(s.dirty);
				setAhead(s.ahead);
				setBehind(s.behind);
			});
		}, STATUS_TTL_MS);

		return () => {
			mountedRef.current = false;
			clearInterval(branchTimer);
			clearInterval(statusTimer);
		};
	}, []);

	return { branch, dirty, ahead, behind };
}
