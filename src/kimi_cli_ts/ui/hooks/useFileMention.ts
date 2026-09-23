/**
 * useFileMention hook — scans workspace files for @ mention completion.
 * Matches Python's LocalFileMentionCompleter in prompt.py.
 *
 * - Top-level scan when fragment is short (< 3 chars, no /)
 * - Deep recursive scan otherwise
 * - Caches results for 2s
 * - Ignores .git, node_modules, __pycache__, etc.
 * - Fuzzy-filters results
 * - Limit 1000 entries
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REFRESH_INTERVAL = 2000; // 2s cache
const LIMIT = 1000;

// ── Ignored names (ported from Python LocalFileMentionCompleter) ──

const IGNORED_NAMES = new Set([
	// VCS metadata
	".DS_Store",
	".bzr",
	".git",
	".hg",
	".svn",
	// Tooling caches
	".build",
	".cache",
	".coverage",
	".fleet",
	".gradle",
	".idea",
	".ipynb_checkpoints",
	".pnpm-store",
	".pytest_cache",
	".pub-cache",
	".ruff_cache",
	".swiftpm",
	".tox",
	".venv",
	".vs",
	".vscode",
	".yarn",
	".yarn-cache",
	// JS/frontend
	".next",
	".nuxt",
	".parcel-cache",
	".svelte-kit",
	".turbo",
	".vercel",
	"node_modules",
	// Python packaging
	"__pycache__",
	"build",
	"coverage",
	"dist",
	"htmlcov",
	"pip-wheel-metadata",
	"venv",
	// Java/JVM
	".mvn",
	"out",
	"target",
	// Dotnet/native
	"bin",
	"cmake-build-debug",
	"cmake-build-release",
	"obj",
	// Bazel/Buck
	"bazel-bin",
	"bazel-out",
	"bazel-testlogs",
	"buck-out",
	// Misc
	".dart_tool",
	".serverless",
	".stack-work",
	".terraform",
	".terragrunt-cache",
	"DerivedData",
	"Pods",
	"deps",
	"tmp",
	"vendor",
]);

const IGNORED_PATTERN =
	/(?:.*_cache|.*-cache|.*\.egg-info|.*\.dist-info|.*\.py[co]|.*\.class|.*\.sw[po]|.*~|.*\.(?:tmp|bak))$/i;

function isIgnored(name: string): boolean {
	if (!name) return true;
	if (IGNORED_NAMES.has(name)) return true;
	return IGNORED_PATTERN.test(name);
}

// ── File scanning ──

function scanTopLevel(root: string): string[] {
	const entries: string[] = [];
	try {
		const items = readdirSync(root).sort();
		for (const name of items) {
			if (isIgnored(name)) continue;
			try {
				const stat = statSync(join(root, name));
				entries.push(stat.isDirectory() ? `${name}/` : name);
			} catch {
				/* skip */
			}
			if (entries.length >= LIMIT) break;
		}
	} catch {
		/* skip */
	}
	return entries;
}

function scanDeep(root: string): string[] {
	const paths: string[] = [];

	function walk(dir: string) {
		if (paths.length >= LIMIT) return;
		let items: string[];
		try {
			items = readdirSync(dir).sort();
		} catch {
			return;
		}

		const subdirs: string[] = [];
		for (const name of items) {
			if (paths.length >= LIMIT) break;
			if (isIgnored(name)) continue;
			const full = join(dir, name);
			try {
				const stat = statSync(full);
				const rel = relative(root, full).split(sep).join("/");
				if (stat.isDirectory()) {
					paths.push(rel + "/");
					subdirs.push(full);
				} else {
					paths.push(rel);
				}
			} catch {
				/* skip */
			}
		}
		for (const sub of subdirs) {
			if (paths.length >= LIMIT) break;
			walk(sub);
		}
	}

	walk(root);
	return paths;
}

// ── Fuzzy matching (reused from SlashMenu) ──

function fuzzyScore(text: string, pattern: string): number {
	let ti = 0;
	let pi = 0;
	let score = 0;
	let consecutive = 0;

	while (ti < text.length && pi < pattern.length) {
		if (text[ti] === pattern[pi]) {
			score += 1 + consecutive;
			consecutive++;
			if (ti === pi) score += 2;
			pi++;
		} else {
			consecutive = 0;
		}
		ti++;
	}
	return pi === pattern.length ? score : 0;
}

function fuzzyFilter(
	paths: string[],
	fragment: string,
	maxResults = 20,
): string[] {
	if (!fragment) return paths.slice(0, maxResults);
	const lower = fragment.toLowerCase();
	return paths
		.map((p) => {
			const nameScore = fuzzyScore(p.toLowerCase(), lower);
			// Bonus for basename match
			const base = p.replace(/\/$/, "").split("/").pop() ?? "";
			const baseScore = fuzzyScore(base.toLowerCase(), lower);
			const best = Math.max(nameScore, baseScore * 1.5);
			return { path: p, score: best };
		})
		.filter((r) => r.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, maxResults)
		.map((r) => r.path);
}

// ── @ mention extraction ──

/** Guard chars that prevent @ from triggering (e.g. inside emails) */
const TRIGGER_GUARDS = new Set([
	".",
	"-",
	"_",
	"`",
	"'",
	'"',
	":",
	"@",
	"#",
	"~",
]);

/**
 * Extract the @ fragment from input text (from the last @).
 * Returns null if @ should not trigger completion.
 */
export function extractMentionFragment(text: string): string | null {
	const idx = text.lastIndexOf("@");
	if (idx === -1) return null;

	// Guard: @ must be preceded by whitespace or be at start
	if (idx > 0) {
		const prev = text[idx - 1]!;
		if (prev.match(/[a-zA-Z0-9]/) || TRIGGER_GUARDS.has(prev)) {
			return null;
		}
	}

	const fragment = text.slice(idx + 1);

	// If fragment has whitespace, @ mention is over
	if (/\s/.test(fragment)) return null;

	return fragment;
}

// ── Hook ──

export interface FileMentionState {
	/** Filtered suggestions for current fragment */
	suggestions: string[];
	/** Whether the mention menu should be shown */
	isActive: boolean;
	/** Current fragment being typed */
	fragment: string;
}

export function useFileMention(
	inputValue: string,
	workDir?: string,
): FileMentionState {
	const [topPaths, setTopPaths] = useState<string[]>([]);
	const [deepPaths, setDeepPaths] = useState<string[]>([]);
	const topCacheTime = useRef(0);
	const deepCacheTime = useRef(0);

	const fragment = extractMentionFragment(inputValue);
	const isActive = fragment !== null;

	// Determine which scan to use
	const needsDeep =
		fragment !== null && (fragment.includes("/") || fragment.length >= 3);

	// Refresh scan when needed
	useEffect(() => {
		if (!workDir || fragment === null) return;
		const now = Date.now();

		if (needsDeep) {
			if (now - deepCacheTime.current > REFRESH_INTERVAL) {
				deepCacheTime.current = now;
				// Run scan async-ish (sync but in effect)
				setDeepPaths(scanDeep(workDir));
			}
		} else {
			if (now - topCacheTime.current > REFRESH_INTERVAL) {
				topCacheTime.current = now;
				setTopPaths(scanTopLevel(workDir));
			}
		}
	}, [workDir, fragment, needsDeep]);

	const basePaths = needsDeep ? deepPaths : topPaths;
	const suggestions = fragment !== null ? fuzzyFilter(basePaths, fragment) : [];

	return {
		suggestions,
		isActive,
		fragment: fragment ?? "",
	};
}
