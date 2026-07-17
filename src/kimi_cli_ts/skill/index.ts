/**
 * Skill specification discovery and loading — corresponds to Python skill/__init__.py
 */

import { join, resolve, dirname } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { logger } from "../utils/logging.ts";
import type { Flow } from "./flow/index.ts";
import { FlowError } from "./flow/index.ts";
import { parseMermaidFlowchart } from "./flow/mermaid.ts";
import { parseD2Flowchart } from "./flow/d2.ts";

export type SkillType = "standard" | "flow";

export interface Skill {
	readonly name: string;
	readonly description: string;
	readonly type: SkillType;
	readonly dir: string;
	readonly flow?: Flow;
	readonly skillMdFile: string;
}

// ── Directory discovery ──

export function getBuiltinSkillsDir(): string {
	// Builtin skills are shared with the Python version under src/kimi_cli/skills/
	// Fall back to TS-local directory if it exists
	const pySkillsDir = join(
		dirname(new URL(import.meta.url).pathname),
		"..",
		"..",
		"kimi_cli",
		"skills",
	);
	if (existsSync(pySkillsDir)) return pySkillsDir;
	return join(dirname(new URL(import.meta.url).pathname), "..", "skills");
}

/**
 * Brand directories — tool-specific paths that share skills across
 * Kimi CLI / Claude / Codex.
 */
function getUserBrandSkillsDirCandidates(): string[] {
	const home = homedir();
	return [
		join(home, ".kimi", "skills"),
		join(home, ".claude", "skills"),
		join(home, ".codex", "skills"),
	];
}

/**
 * Generic directories — cross-tool standard paths.
 */
function getUserGenericSkillsDirCandidates(): string[] {
	const home = homedir();
	return [
		join(home, ".config", "agents", "skills"),
		join(home, ".agents", "skills"),
	];
}

/** @deprecated Use {@link findUserSkillsDirs} instead. */
export function getUserSkillsDirCandidates(): string[] {
	return [
		...getUserGenericSkillsDirCandidates(),
		...getUserBrandSkillsDirCandidates(),
	];
}

function getProjectBrandSkillsDirCandidates(workDir: string): string[] {
	return [
		join(workDir, ".kimi", "skills"),
		join(workDir, ".claude", "skills"),
		join(workDir, ".codex", "skills"),
	];
}

function getProjectGenericSkillsDirCandidates(workDir: string): string[] {
	return [join(workDir, ".agents", "skills")];
}

/** @deprecated Use {@link findProjectSkillsDirs} instead. */
export function getProjectSkillsDirCandidates(workDir: string): string[] {
	return [
		...getProjectGenericSkillsDirCandidates(workDir),
		...getProjectBrandSkillsDirCandidates(workDir),
	];
}

export function findFirstExistingDir(candidates: string[]): string | undefined {
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate) && statSync(candidate).isDirectory()) {
				return candidate;
			}
		} catch {
			continue;
		}
	}
	return undefined;
}

function findAllExistingDirs(candidates: string[]): string[] {
	const dirs: string[] = [];
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate) && statSync(candidate).isDirectory()) {
				dirs.push(candidate);
			}
		} catch {
			continue;
		}
	}
	return dirs;
}

/**
 * Return the user-level skills directories.
 *
 * Brand and generic groups are searched independently — the first existing
 * directory inside each group is selected, then both results are merged so
 * that brand-specific skills and generic skills coexist.
 *
 * When `mergeBrands` is true every existing brand directory is included
 * instead of only the first one.
 */
export function findUserSkillsDirs(opts?: { mergeBrands?: boolean }): string[] {
	const dirs: string[] = [];

	// Brand group — higher priority (comes first so brand skills win on name conflicts)
	if (opts?.mergeBrands) {
		dirs.push(...findAllExistingDirs(getUserBrandSkillsDirCandidates()));
	} else {
		const brandDir = findFirstExistingDir(getUserBrandSkillsDirCandidates());
		if (brandDir) dirs.push(brandDir);
	}

	// Generic group
	const genericDir = findFirstExistingDir(getUserGenericSkillsDirCandidates());
	if (genericDir) dirs.push(genericDir);

	return dirs;
}

/** @deprecated Use {@link findUserSkillsDirs} instead. */
export function findUserSkillsDir(): string | undefined {
	return findFirstExistingDir(getUserSkillsDirCandidates());
}

/**
 * Return the project-level skills directories.
 *
 * Same two-group strategy as {@link findUserSkillsDirs}.
 */
export function findProjectSkillsDirs(
	workDir: string,
	opts?: { mergeBrands?: boolean },
): string[] {
	const dirs: string[] = [];

	if (opts?.mergeBrands) {
		dirs.push(
			...findAllExistingDirs(getProjectBrandSkillsDirCandidates(workDir)),
		);
	} else {
		const brandDir = findFirstExistingDir(
			getProjectBrandSkillsDirCandidates(workDir),
		);
		if (brandDir) dirs.push(brandDir);
	}

	const genericDir = findFirstExistingDir(
		getProjectGenericSkillsDirCandidates(workDir),
	);
	if (genericDir) dirs.push(genericDir);

	return dirs;
}

/** @deprecated Use {@link findProjectSkillsDirs} instead. */
export function findProjectSkillsDir(workDir: string): string | undefined {
	return findFirstExistingDir(getProjectSkillsDirCandidates(workDir));
}

export function resolveSkillsRoots(
	workDir: string,
	opts?: { skillsDirs?: string[]; mergeBrands?: boolean },
): string[] {
	const roots: string[] = [];
	const builtinDir = getBuiltinSkillsDir();
	if (existsSync(builtinDir)) roots.push(builtinDir);

	if (opts?.skillsDirs && opts.skillsDirs.length > 0) {
		roots.push(...opts.skillsDirs);
	} else {
		const userDirs = findUserSkillsDirs({ mergeBrands: opts?.mergeBrands });
		roots.push(...userDirs);
		const projectDirs = findProjectSkillsDirs(workDir, {
			mergeBrands: opts?.mergeBrands,
		});
		roots.push(...projectDirs);
	}
	return roots;
}

// ── Skill parsing ──

export function normalizeSkillName(name: string): string {
	return name.toLowerCase();
}

export function indexSkills(skills: Skill[]): Map<string, Skill> {
	const map = new Map<string, Skill>();
	for (const skill of skills) {
		map.set(normalizeSkillName(skill.name), skill);
	}
	return map;
}

export function discoverSkillsFromRoots(skillsDirs: string[]): Skill[] {
	const skillsByName = new Map<string, Skill>();
	for (const dir of skillsDirs) {
		for (const skill of discoverSkills(dir)) {
			const key = normalizeSkillName(skill.name);
			if (!skillsByName.has(key)) {
				skillsByName.set(key, skill);
			}
		}
	}
	return [...skillsByName.values()].sort((a, b) =>
		a.name.localeCompare(b.name),
	);
}

export function readSkillText(skill: Skill): string | undefined {
	try {
		return readFileSync(skill.skillMdFile, "utf-8").trim();
	} catch {
		logger.warn(`Failed to read skill file ${skill.skillMdFile}`);
		return undefined;
	}
}

export function discoverSkills(skillsDir: string): Skill[] {
	if (!existsSync(skillsDir)) return [];
	try {
		if (!statSync(skillsDir).isDirectory()) return [];
	} catch {
		return [];
	}

	const skills: Skill[] = [];
	for (const entry of readdirSync(skillsDir)) {
		const skillDir = join(skillsDir, entry);
		try {
			if (!statSync(skillDir).isDirectory()) continue;
		} catch {
			continue;
		}
		const skillMd = join(skillDir, "SKILL.md");
		if (!existsSync(skillMd)) continue;

		try {
			const content = readFileSync(skillMd, "utf-8");
			skills.push(parseSkillText(content, skillDir));
		} catch (err) {
			logger.info(`Skipping invalid skill at ${skillMd}: ${err}`);
		}
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function parseSkillText(content: string, dirPath: string): Skill {
	const frontmatter = parseFrontmatter(content) ?? {};
	const name =
		(frontmatter.name as string) || dirPath.split("/").pop() || "unknown";
	const description =
		(frontmatter.description as string) || "No description provided.";
	let skillType: SkillType = ((frontmatter.type as string) ||
		"standard") as SkillType;

	if (skillType !== "standard" && skillType !== "flow") {
		throw new Error(`Invalid skill type "${skillType}"`);
	}

	let flow: Flow | undefined;
	if (skillType === "flow") {
		try {
			flow = parseFlowFromSkill(content);
		} catch (err) {
			logger.error(`Failed to parse flow skill ${name}: ${err}`);
			skillType = "standard";
			flow = undefined;
		}
	}

	return {
		name,
		description,
		type: skillType,
		dir: dirPath,
		flow,
		skillMdFile: join(dirPath, "SKILL.md"),
	};
}

function parseFlowFromSkill(content: string): Flow {
	for (const [lang, code] of iterFencedCodeblocks(content)) {
		if (lang === "mermaid") return parseMermaidFlowchart(code);
		if (lang === "d2") return parseD2Flowchart(code);
	}
	throw new Error(
		"Flow skills require a mermaid or d2 code block in SKILL.md.",
	);
}

function* iterFencedCodeblocks(content: string): Generator<[string, string]> {
	let fence = "";
	let fenceChar = "";
	let lang = "";
	let buf: string[] = [];
	let inBlock = false;

	for (const line of content.split("\n")) {
		const stripped = line.trimStart();
		if (!inBlock) {
			const match = parseFenceOpen(stripped);
			if (match) {
				[fence, fenceChar, lang] = match;
				lang = normalizeCodeLang(lang);
				inBlock = true;
				buf = [];
			}
			continue;
		}

		if (isFenceClose(stripped, fenceChar, fence.length)) {
			yield [lang, buf.join("\n").replace(/^\n+|\n+$/g, "")];
			inBlock = false;
			fence = "";
			fenceChar = "";
			lang = "";
			buf = [];
			continue;
		}

		buf.push(line);
	}
}

function normalizeCodeLang(info: string): string {
	if (!info) return "";
	let lang = info.split(/\s+/)[0]!.trim().toLowerCase();
	if (lang.startsWith("{") && lang.endsWith("}")) {
		lang = lang.slice(1, -1).trim();
	}
	return lang;
}

function parseFenceOpen(line: string): [string, string, string] | undefined {
	if (!line || (line[0] !== "`" && line[0] !== "~")) return undefined;
	const fenceChar = line[0]!;
	let count = 0;
	for (const ch of line) {
		if (ch === fenceChar) count++;
		else break;
	}
	if (count < 3) return undefined;
	const fence = fenceChar.repeat(count);
	const info = line.slice(count).trim();
	return [fence, fenceChar, info];
}

function isFenceClose(
	line: string,
	fenceChar: string,
	fenceLen: number,
): boolean {
	if (!fenceChar || !line || line[0] !== fenceChar) return false;
	let count = 0;
	for (const ch of line) {
		if (ch === fenceChar) count++;
		else break;
	}
	if (count < fenceLen) return false;
	return !line.slice(count).trim();
}

// Simple frontmatter parser
function parseFrontmatter(content: string): Record<string, string> | undefined {
	const lines = content.split("\n");
	if (lines[0]?.trim() !== "---") return undefined;

	const result: Record<string, string> = {};
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.trim() === "---") return result;
		const colonIdx = line.indexOf(":");
		if (colonIdx > 0) {
			const key = line.slice(0, colonIdx).trim();
			const value = line.slice(colonIdx + 1).trim();
			// Strip quotes
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				result[key] = value.slice(1, -1);
			} else {
				result[key] = value;
			}
		}
	}
	return undefined; // No closing ---
}
