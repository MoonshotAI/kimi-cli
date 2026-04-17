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

import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { load as yamlLoad } from 'js-yaml';
import nunjucks from 'nunjucks';

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
  /** Path to the system prompt template file (e.g. system.md), or null if not specified. */
  systemPromptPath: string | null;
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
    systemPromptPath: raw.system_prompt_path ?? null,
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

// ── System prompt template rendering ─────────────────────────────────

/**
 * Compute the built-in template variables (Python parity:
 * `BuiltinSystemPromptArgs` in `agent.py`).
 *
 * Note: KIMI_AGENTS_MD, KIMI_SKILLS, KIMI_WORK_DIR_LS, and
 * KIMI_ADDITIONAL_DIRS_INFO are expensive to compute and depend on
 * runtime state. In Slice 6.0 we pass empty strings — the full
 * values are injected at session init time (future slice).
 */
function getBuiltinVars(): Record<string, string> {
  const platform = process.platform;
  let osName: string;
  if (platform === 'win32') {
    osName = 'Windows';
  } else if (platform === 'darwin') {
    osName = 'macOS';
  } else {
    osName = 'Linux';
  }

  const shell = process.env['SHELL'] ?? (platform === 'win32' ? 'powershell' : '/bin/sh');
  const shellName = basename(shell);

  return {
    KIMI_OS: osName,
    KIMI_SHELL: `${shellName} (\`${shell}\`)`,
    KIMI_NOW: new Date().toISOString(),
    KIMI_WORK_DIR: process.cwd(),
    KIMI_WORK_DIR_LS: '',
    KIMI_AGENTS_MD: '',
    KIMI_SKILLS: '',
    KIMI_ADDITIONAL_DIRS_INFO: '',
  };
}

/**
 * Render a system.md template with the given variables.
 *
 * The template uses `${VAR}` syntax (Jinja2/Python parity) and
 * `{% if %}` blocks (standard Jinja2). Since nunjucks uses `{{ }}`
 * for variables, we pre-process `${VAR}` → `{{ VAR }}` before
 * rendering.
 *
 * Python parity: `agent.py:_load_system_prompt`
 */
function renderSystemPromptTemplate(
  templateText: string,
  vars: Record<string, string>,
): string {
  // Convert ${VAR_NAME} → {{ VAR_NAME }} for nunjucks compatibility.
  // Only match known variable patterns (word chars).
  const converted = templateText.replaceAll(/\$\{(\w+)\}/g, '{{ $1 }}');

  const env = new nunjucks.Environment(null, {
    autoescape: false,
    trimBlocks: true,
    lstripBlocks: true,
    // Python parity: Jinja2 StrictUndefined — undefined vars throw
    // instead of silently rendering as empty string.
    throwOnUndefined: true,
  });

  return env.renderString(converted, vars);
}

/**
 * Try to load and render a system prompt template.
 * Returns null if the file doesn't exist or can't be read.
 */
async function tryLoadSystemPrompt(
  systemPromptPath: string,
  args: Record<string, string>,
): Promise<string | null> {
  let templateText: string;
  try {
    templateText = await readFile(systemPromptPath, 'utf-8');
  } catch {
    // File doesn't exist or can't be read — fall back gracefully
    return null;
  }

  const builtinVars = getBuiltinVars();
  const allVars = { ...builtinVars, ...args };

  return renderSystemPromptTemplate(templateText.trim(), allVars);
}

// ── High-level: load all subagent type definitions ────────────────────

/**
 * Given the parent agent.yaml path, discover and load all subagent type
 * definitions. Maps Python tool paths to TS names.
 *
 * When the parent spec has a `system_prompt_path`, the template is loaded
 * and rendered with built-in variables + each child's `ROLE_ADDITIONAL`.
 * If the template file is missing, falls back to bare `ROLE_ADDITIONAL`.
 *
 * Python parity: `agent.py:421-442` (labor_market registration loop)
 * + `agent.py:_load_system_prompt` (template rendering).
 */
export async function loadSubagentTypes(
  parentAgentYamlPath: string,
): Promise<AgentTypeDefinition[]> {
  const parentSpec = await loadAgentSpec(parentAgentYamlPath);
  const types: AgentTypeDefinition[] = [];

  // Resolve the system prompt path relative to the parent YAML directory
  const parentDir = dirname(parentAgentYamlPath);
  const systemPromptAbsPath =
    parentSpec.systemPromptPath !== null
      ? resolve(parentDir, parentSpec.systemPromptPath)
      : null;

  for (const [name, ref] of Object.entries(parentSpec.subagents)) {
    const childPath = resolve(parentDir, ref.path);
    const childSpec = await loadAgentSpec(childPath);

    const roleAdditional = childSpec.systemPromptArgs['ROLE_ADDITIONAL'] ?? '';

    // Try to render the full system prompt with ROLE_ADDITIONAL substituted
    let systemPromptSuffix: string;
    if (systemPromptAbsPath !== null) {
      const rendered = await tryLoadSystemPrompt(systemPromptAbsPath, {
        ...childSpec.systemPromptArgs,
        ROLE_ADDITIONAL: roleAdditional,
      });
      systemPromptSuffix = rendered ?? roleAdditional;
    } else {
      systemPromptSuffix = roleAdditional;
    }

    types.push({
      name,
      description: ref.description,
      whenToUse: childSpec.whenToUse,
      systemPromptSuffix,
      allowedTools: childSpec.allowedTools !== null ? mapToolNames(childSpec.allowedTools) : null,
      excludeTools: mapToolNames(childSpec.excludeTools),
      defaultModel: childSpec.model,
    });
  }

  return types;
}

// ── Bundled YAML discovery (Slice 5.3 D4) ─────────────────────────────

/**
 * Resolve the absolute path to the bundled default `agent.yaml`.
 *
 * `@moonshot-ai/core` ships with `agents/default/agent.yaml` (plus its
 * sibling `coder.yaml` / `explore.yaml` / `plan.yaml`) so embedders
 * don't need to know where the file physically lives. Because the
 * module is loaded from `src/soul-plus/` in dev (tsx) and from a
 * flattened `dist/` after bundling, this helper probes both layouts
 * via `fs.stat` and returns the first path that exists.
 *
 * Requires `packages/kimi-core/agents/` to appear in the package's
 * `files` array so the yaml fixtures get published alongside `dist/`.
 *
 * Throws when neither candidate resolves — a packaging regression.
 */
export async function getBundledAgentYamlPath(): Promise<string> {
  // `import.meta.dirname` is Node ≥21.2; fall back to the ES2020
  // fileURLToPath + dirname recipe so the helper works on Node 18 / 20
  // LTS without bumping the package's `engines.node` floor.
  const moduleDir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
  // Dev layout: this file lives at `src/soul-plus/` so `../../agents`
  // lands on the package root `agents/` directory. Bundled layout:
  // the flattened `dist/` sits one level below the package root so
  // `../agents` is the sibling `agents/` directory.
  const candidates = [
    resolve(moduleDir, '..', '..', 'agents', 'default', 'agent.yaml'),
    resolve(moduleDir, '..', 'agents', 'default', 'agent.yaml'),
  ];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    `getBundledAgentYamlPath: unable to locate bundled agent.yaml. ` +
      `Checked: ${candidates.join(', ')}. ` +
      `The '@moonshot-ai/core' package must include 'agents/' in its ` +
      `published 'files' array.`,
  );
}
