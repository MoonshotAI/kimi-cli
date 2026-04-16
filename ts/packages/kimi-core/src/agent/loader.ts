/**
 * Agent YAML file loader — Slice 3.1.
 *
 * Reads an `agent.yaml` file from disk, parses the YAML content,
 * and returns an `AgentSpec` object. `systemPromptPath` is resolved
 * relative to the directory containing the agent.yaml file.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { AgentSpecError } from './errors.js';
import type { AgentSpec, SkillFilter, ToolFilter } from './types.js';
import { parseAgentYaml } from './yaml-parser.js';

/**
 * Load an AgentSpec from an `agent.yaml` file path.
 *
 * @param agentFilePath — absolute or relative path to the agent.yaml file.
 * @returns Parsed `AgentSpec` with paths resolved relative to the yaml file.
 * @throws `AgentSpecError` if the file cannot be read or parsed.
 */
export function loadAgentFile(agentFilePath: string): AgentSpec {
  let content: string;
  try {
    content = readFileSync(agentFilePath, 'utf-8');
  } catch (error) {
    throw new AgentSpecError(
      `Cannot read agent file: ${agentFilePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return parseAgentSpec(content, agentFilePath);
}

/**
 * Parse raw YAML text into an AgentSpec. Exported for testing.
 */
export function parseAgentSpec(yamlText: string, filePath?: string): AgentSpec {
  let raw: Record<string, unknown>;
  try {
    raw = parseAgentYaml(yamlText);
  } catch (error) {
    throw new AgentSpecError(
      `Invalid YAML in agent file${filePath ? ` ${filePath}` : ''}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const name = raw['name'];
  if (typeof name !== 'string' || name === '') {
    throw new AgentSpecError(
      `Agent "name" is required and must be a non-empty string${filePath ? ` in ${filePath}` : ''}`,
    );
  }

  const baseDir = filePath ? dirname(filePath) : process.cwd();

  // Resolve systemPromptPath relative to agent.yaml directory
  let systemPromptPath =
    asOptionalString(raw, 'system_prompt_path') ?? asOptionalString(raw, 'systemPromptPath');
  if (systemPromptPath !== undefined && !isAbsolute(systemPromptPath)) {
    systemPromptPath = resolve(baseDir, systemPromptPath);
  }

  const spec: AgentSpec = {
    name,
    description: asOptionalString(raw, 'description'),
    systemPrompt: asOptionalString(raw, 'system_prompt') ?? asOptionalString(raw, 'systemPrompt'),
    systemPromptPath,
    model: asOptionalString(raw, 'model'),
    thinkingMode: asThinkingMode(raw),
    thinkingEffort:
      asOptionalString(raw, 'thinking_effort') ?? asOptionalString(raw, 'thinkingEffort'),
    tools: asFilter(raw, 'tools'),
    skills: asFilter(raw, 'skills'),
    inherits: asOptionalString(raw, 'inherits'),
  };

  return spec;
}

/**
 * Load the system prompt content from file when `systemPromptPath` is set.
 */
export function loadSystemPromptFile(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch (error) {
    throw new AgentSpecError(
      `Cannot read system prompt file: ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function asOptionalString(raw: Record<string, unknown>, key: string): string | undefined {
  const val = raw[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  // Non-scalar TOML values (tables, arrays, nested objects) are rejected
  // to avoid `[object Object]` leaking into agent spec fields.
  return undefined;
}

function asThinkingMode(raw: Record<string, unknown>): 'auto' | 'on' | 'off' | undefined {
  const val = asOptionalString(raw, 'thinking_mode') ?? asOptionalString(raw, 'thinkingMode');
  if (val === undefined) return undefined;
  if (val === 'auto' || val === 'on' || val === 'off') return val;
  throw new AgentSpecError(`Invalid thinking_mode: "${val}" (expected "auto", "on", or "off")`);
}

function asFilter(raw: Record<string, unknown>, key: string): ToolFilter | SkillFilter | undefined {
  const val = raw[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'object' || Array.isArray(val)) {
    throw new AgentSpecError(`"${key}" must be a mapping with optional "include"/"exclude" arrays`);
  }
  const obj = val as Record<string, unknown>;
  return {
    include: asStringArray(obj, 'include'),
    exclude: asStringArray(obj, 'exclude'),
  };
}

function asStringArray(obj: Record<string, unknown>, key: string): readonly string[] | undefined {
  const val = obj[key];
  if (val === undefined || val === null) return undefined;
  if (!Array.isArray(val)) {
    throw new AgentSpecError(`"${key}" must be an array of strings`);
  }
  return val.map((item) => {
    if (typeof item === 'string') return item;
    return String(item);
  });
}
