/**
 * Agent spec loader — corresponds to Python agentspec.py
 * Loads agent YAML specifications with inheritance support.
 */

import { join, dirname, resolve } from "node:path";
import { z } from "zod/v4";
import { parse as parseYaml } from "./utils/yaml.ts";

// ── Constants ───────────────────────────────────────────

const DEFAULT_AGENT_SPEC_VERSION = "1";
const SUPPORTED_VERSIONS = new Set([DEFAULT_AGENT_SPEC_VERSION]);

export function getAgentsDir(): string {
	return join(dirname(import.meta.dir), "kimi_cli", "agents");
}

const INHERIT = Symbol("inherit");
type Inherit = typeof INHERIT;

// ── Types ───────────────────────────────────────────────

export interface SubagentSpec {
	path: string;
	description: string;
}

export interface AgentSpec {
	extend?: string;
	name: string | Inherit;
	systemPromptPath: string | Inherit;
	systemPromptArgs: Record<string, string>;
	model?: string;
	whenToUse?: string;
	tools: string[] | null | Inherit;
	allowedTools: string[] | null | Inherit;
	excludeTools: string[] | null | Inherit;
	subagents: Record<string, SubagentSpec> | null | Inherit;
}

export interface ResolvedAgentSpec {
	name: string;
	systemPromptPath: string;
	systemPromptArgs: Record<string, string>;
	model: string | null;
	whenToUse: string;
	tools: string[];
	allowedTools: string[] | null;
	excludeTools: string[];
	subagents: Record<string, SubagentSpec>;
}

// ── Errors ──────────────────────────────────────────────

export class AgentSpecError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentSpecError";
	}
}

// ── Loader ──────────────────────────────────────────────

function parseAgentData(
	data: Record<string, unknown>,
	agentFileDir: string,
): AgentSpec {
	const agent = (data.agent ?? {}) as Record<string, unknown>;

	const spec: AgentSpec = {
		extend: agent.extend as string | undefined,
		name: agent.name != null ? String(agent.name) : INHERIT,
		systemPromptPath:
			agent.system_prompt_path != null
				? resolve(agentFileDir, String(agent.system_prompt_path))
				: INHERIT,
		systemPromptArgs:
			(agent.system_prompt_args as Record<string, string>) ?? {},
		model: agent.model != null ? String(agent.model) : undefined,
		whenToUse:
			agent.when_to_use != null ? String(agent.when_to_use) : undefined,
		tools:
			agent.tools !== undefined ? (agent.tools as string[] | null) : INHERIT,
		allowedTools:
			agent.allowed_tools !== undefined
				? (agent.allowed_tools as string[] | null)
				: INHERIT,
		excludeTools:
			agent.exclude_tools !== undefined
				? (agent.exclude_tools as string[] | null)
				: INHERIT,
		subagents:
			agent.subagents !== undefined
				? parseSubagents(
						agent.subagents as Record<string, unknown>,
						agentFileDir,
					)
				: INHERIT,
	};

	return spec;
}

function parseSubagents(
	raw: Record<string, unknown> | null,
	baseDir: string,
): Record<string, SubagentSpec> | null {
	if (!raw) return null;
	const result: Record<string, SubagentSpec> = {};
	for (const [key, val] of Object.entries(raw)) {
		const v = val as Record<string, unknown>;
		result[key] = {
			path: resolve(baseDir, String(v.path)),
			description: String(v.description ?? ""),
		};
	}
	return result;
}

async function loadAgentSpecRaw(agentFile: string): Promise<AgentSpec> {
	const file = Bun.file(agentFile);
	if (!(await file.exists())) {
		throw new AgentSpecError(`Agent spec file not found: ${agentFile}`);
	}

	const text = await file.text();
	const data = parseYaml(text) as Record<string, unknown>;

	const version = String(data.version ?? DEFAULT_AGENT_SPEC_VERSION);
	if (!SUPPORTED_VERSIONS.has(version)) {
		throw new AgentSpecError(`Unsupported agent spec version: ${version}`);
	}

	const agentFileDir = dirname(agentFile);
	const spec = parseAgentData(data, agentFileDir);

	// Handle inheritance
	if (spec.extend) {
		const baseFile =
			spec.extend === "default"
				? join(getAgentsDir(), "default", "agent.yaml")
				: resolve(agentFileDir, spec.extend);

		const base = await loadAgentSpecRaw(baseFile);

		if (spec.name !== INHERIT) base.name = spec.name;
		if (spec.systemPromptPath !== INHERIT)
			base.systemPromptPath = spec.systemPromptPath;
		// Merge system prompt args
		for (const [k, v] of Object.entries(spec.systemPromptArgs)) {
			base.systemPromptArgs[k] = v;
		}
		if (spec.model != null) base.model = spec.model;
		if (spec.whenToUse != null) base.whenToUse = spec.whenToUse;
		if (spec.tools !== INHERIT) base.tools = spec.tools;
		if (spec.allowedTools !== INHERIT) base.allowedTools = spec.allowedTools;
		if (spec.excludeTools !== INHERIT) base.excludeTools = spec.excludeTools;
		if (spec.subagents !== INHERIT) base.subagents = spec.subagents;

		base.extend = undefined;
		return base;
	}

	return spec;
}

export async function loadAgentSpec(
	agentFile: string,
): Promise<ResolvedAgentSpec> {
	const spec = await loadAgentSpecRaw(agentFile);

	if (spec.name === INHERIT) throw new AgentSpecError("Agent name is required");
	if (spec.systemPromptPath === INHERIT)
		throw new AgentSpecError("System prompt path is required");
	if (spec.tools === INHERIT) throw new AgentSpecError("Tools are required");

	return {
		name: spec.name as string,
		systemPromptPath: spec.systemPromptPath as string,
		systemPromptArgs: spec.systemPromptArgs,
		model: spec.model ?? null,
		whenToUse: spec.whenToUse ?? "",
		tools: (spec.tools as string[]) ?? [],
		allowedTools:
			spec.allowedTools === INHERIT
				? null
				: (spec.allowedTools as string[] | null),
		excludeTools:
			spec.excludeTools === INHERIT
				? []
				: ((spec.excludeTools as string[]) ?? []),
		subagents:
			spec.subagents === INHERIT
				? {}
				: ((spec.subagents as Record<string, SubagentSpec>) ?? {}),
	};
}
