/**
 * AgentYamlLoader — parse agent YAML definitions with `extend:` inheritance.
 *
 * Python parity: `kimi_cli.agentspec.load_agent_spec` / `_load_agent_spec`
 *
 * Key responsibilities:
 *   - Load and resolve a single agent YAML file (with recursive `extend`)
 *   - Map Python tool module paths to TS tool names
 *   - Discover subagent type definitions from the parent agent.yaml
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { load as yamlLoad } from 'js-yaml';

import type { AgentTypeDefinition } from './agent-type-registry.js';

// ── Python → TS tool name mapping ─────────────────────────────────────

/**
 * Maps Python tool module paths (as used in agent YAML) to TS tool class
 * names. Unmapped names are logged as warnings and skipped.
 */
export const PYTHON_TO_TS_TOOL_NAME: Record<string, string> = {
  'kimi_cli.tools.shell:Shell': 'Bash',
  'kimi_cli.tools.file:ReadFile': 'Read',
  'kimi_cli.tools.file:ReadMediaFile': 'Read', // TS uses same Read tool
  'kimi_cli.tools.file:WriteFile': 'Write',
  'kimi_cli.tools.file:StrReplaceFile': 'Edit',
  'kimi_cli.tools.file:Glob': 'Glob',
  'kimi_cli.tools.file:Grep': 'Grep',
  'kimi_cli.tools.agent:Agent': 'Agent',
  'kimi_cli.tools.ask_user:AskUserQuestion': 'AskUserQuestion',
  'kimi_cli.tools.web:SearchWeb': 'SearchWeb',
  'kimi_cli.tools.web:FetchURL': 'FetchURL',
  'kimi_cli.tools.todo:SetTodoList': 'SetTodoList',
  'kimi_cli.tools.background:TaskList': 'TaskList',
  'kimi_cli.tools.background:TaskOutput': 'TaskOutput',
  'kimi_cli.tools.background:TaskStop': 'TaskStop',
  'kimi_cli.tools.plan:ExitPlanMode': 'ExitPlanMode',
  'kimi_cli.tools.plan.enter:EnterPlanMode': 'EnterPlanMode',
};

/**
 * Convert a Python tool path to a TS tool name.
 * Returns null for unmapped paths.
 */
export function mapToolName(pythonPath: string): string | null {
  return PYTHON_TO_TS_TOOL_NAME[pythonPath] ?? null;
}

/**
 * Convert a list of Python tool paths to unique TS tool names.
 * Skips unmapped paths.
 */
function mapToolNames(pythonPaths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of pythonPaths) {
    const ts = mapToolName(p);
    if (ts !== null && !seen.has(ts)) {
      seen.add(ts);
      result.push(ts);
    }
  }
  return result;
}

// ── YAML raw shape ────────────────────────────────────────────────────

/** Raw shape of the `agent:` block in a YAML file. */
interface RawAgentBlock {
  name?: string;
  extend?: string;
  system_prompt_path?: string;
  system_prompt_args?: Record<string, string>;
  model?: string | null;
  when_to_use?: string;
  tools?: string[];
  allowed_tools?: string[];
  exclude_tools?: string[];
  subagents?: Record<string, { path: string; description: string }>;
}

// ── ResolvedAgentSpec ─────────────────────────────────────────────────

export interface ResolvedAgentSpec {
  name: string;
  systemPromptArgs: Record<string, string>;
  model: string | null;
  whenToUse: string;
  /**
   * Parent agent's full tool list from YAML. In Python, this is the fallback
   * when `allowedTools` is null (`agent.py:457`). In TS, we use runtime
   * `parentTools` instead (more dynamic). This field is retained for
   * completeness / potential future use, but not consumed by
   * `AgentTypeRegistry.resolveToolSet()`.
   */
  tools: string[];
  allowedTools: string[] | null;
  excludeTools: string[];
  subagents: Record<string, { path: string; description: string }>;
}

// ── Loader ────────────────────────────────────────────────────────────

/**
 * Load and resolve a single agent YAML file, handling `extend:` inheritance.
 *
 * Python parity: `agentspec.py:load_agent_spec` + `_load_agent_spec`
 */
export async function loadAgentSpec(agentFilePath: string): Promise<ResolvedAgentSpec> {
  const raw = await loadRawAgentBlock(agentFilePath);
  return resolveSpec(raw);
}

/**
 * Recursively load a YAML file, resolving `extend:` chains.
 * Tracks visited paths to detect circular references (parity with
 * `src/agent/inherit.ts` which uses `AgentInheritanceCycleError`).
 */
async function loadRawAgentBlock(
  filePath: string,
  visited: Set<string> = new Set(),
): Promise<RawAgentBlock> {
  const absPath = resolve(filePath);
  if (visited.has(absPath)) {
    throw new Error(`Circular extend detected in agent YAML chain: ${absPath}`);
  }
  visited.add(absPath);

  const content = await readFile(absPath, 'utf-8');
  const doc = yamlLoad(content) as { agent?: RawAgentBlock } | null;

  if (doc === null || doc.agent === undefined) {
    throw new Error(`Invalid agent YAML (missing 'agent:' block): ${absPath}`);
  }

  const agent = doc.agent;

  if (agent.extend !== undefined) {
    const basePath = resolve(dirname(absPath), agent.extend);
    const base = await loadRawAgentBlock(basePath, visited);
    return mergeAgentBlocks(base, agent);
  }

  return agent;
}

/**
 * Merge child overrides onto base (Python parity: agentspec.py:137-159).
 * Child non-undefined fields override base.
 */
function mergeAgentBlocks(base: RawAgentBlock, child: RawAgentBlock): RawAgentBlock {
  const merged: RawAgentBlock = {
    system_prompt_args: {
      ...base.system_prompt_args,
      ...child.system_prompt_args,
    },
  };
  // Only set fields that have a defined value (exactOptionalPropertyTypes compliance)
  const name = child.name ?? base.name;
  if (name !== undefined) merged.name = name;
  const spp = child.system_prompt_path ?? base.system_prompt_path;
  if (spp !== undefined) merged.system_prompt_path = spp;
  const model = child.model !== undefined ? child.model : base.model;
  if (model !== undefined) merged.model = model;
  const wtu = child.when_to_use !== undefined ? child.when_to_use : base.when_to_use;
  if (wtu !== undefined) merged.when_to_use = wtu;
  const tools = child.tools !== undefined ? child.tools : base.tools;
  if (tools !== undefined) merged.tools = tools;
  const at = child.allowed_tools !== undefined ? child.allowed_tools : base.allowed_tools;
  if (at !== undefined) merged.allowed_tools = at;
  const et = child.exclude_tools !== undefined ? child.exclude_tools : base.exclude_tools;
  if (et !== undefined) merged.exclude_tools = et;
  const sa = child.subagents !== undefined ? child.subagents : base.subagents;
  if (sa !== undefined) merged.subagents = sa;
  return merged;
}

/**
 * Convert a raw merged block into the resolved spec with defaults.
 */
function resolveSpec(raw: RawAgentBlock): ResolvedAgentSpec {
  return {
    name: raw.name ?? '',
    systemPromptArgs: raw.system_prompt_args ?? {},
    model: raw.model ?? null,
    whenToUse: raw.when_to_use ?? '',
    tools: raw.tools ?? [],
    allowedTools: raw.allowed_tools ?? null,
    excludeTools: raw.exclude_tools ?? [],
    subagents: raw.subagents ?? {},
  };
}

// ── High-level: load all subagent type definitions ────────────────────

/**
 * Given the parent agent.yaml path, discover and load all subagent type
 * definitions. Maps Python tool paths to TS names.
 *
 * Python parity: `agent.py:421-442` (labor_market registration loop).
 */
export async function loadSubagentTypes(
  parentAgentYamlPath: string,
): Promise<AgentTypeDefinition[]> {
  const parentSpec = await loadAgentSpec(parentAgentYamlPath);
  const types: AgentTypeDefinition[] = [];

  for (const [name, ref] of Object.entries(parentSpec.subagents)) {
    const childPath = resolve(dirname(parentAgentYamlPath), ref.path);
    const childSpec = await loadAgentSpec(childPath);

    types.push({
      name,
      description: ref.description,
      whenToUse: childSpec.whenToUse,
      systemPromptSuffix: childSpec.systemPromptArgs['ROLE_ADDITIONAL'] ?? '',
      allowedTools: childSpec.allowedTools !== null ? mapToolNames(childSpec.allowedTools) : null,
      excludeTools: mapToolNames(childSpec.excludeTools),
      defaultModel: childSpec.model,
    });
  }

  return types;
}
