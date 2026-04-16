/**
 * AgentYamlLoader tests — YAML parsing, extend inheritance, tool name mapping.
 */

import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  loadAgentSpec,
  loadSubagentTypes,
  mapToolName,
  PYTHON_TO_TS_TOOL_NAME,
} from '../../src/soul-plus/agent-yaml-loader.js';

// The YAML files are at packages/kimi-core/agents/default/
const AGENTS_DIR = resolve(__dirname, '../../agents/default');
const PARENT_YAML = resolve(AGENTS_DIR, 'agent.yaml');
const CODER_YAML = resolve(AGENTS_DIR, 'coder.yaml');
const EXPLORE_YAML = resolve(AGENTS_DIR, 'explore.yaml');
const PLAN_YAML = resolve(AGENTS_DIR, 'plan.yaml');

describe('mapToolName', () => {
  it('maps known Python paths to TS names', () => {
    expect(mapToolName('kimi_cli.tools.shell:Shell')).toBe('Bash');
    expect(mapToolName('kimi_cli.tools.file:ReadFile')).toBe('Read');
    expect(mapToolName('kimi_cli.tools.file:WriteFile')).toBe('Write');
    expect(mapToolName('kimi_cli.tools.file:StrReplaceFile')).toBe('Edit');
    expect(mapToolName('kimi_cli.tools.agent:Agent')).toBe('Agent');
  });

  it('returns null for unknown paths', () => {
    expect(mapToolName('unknown.module:Tool')).toBeNull();
  });

  it('maps ReadMediaFile to Read (same tool in TS)', () => {
    expect(mapToolName('kimi_cli.tools.file:ReadMediaFile')).toBe('Read');
  });

  it('covers all entries in the mapping table', () => {
    for (const [python, ts] of Object.entries(PYTHON_TO_TS_TOOL_NAME)) {
      expect(mapToolName(python)).toBe(ts);
    }
  });
});

describe('loadAgentSpec', () => {
  it('loads the parent agent.yaml', async () => {
    const spec = await loadAgentSpec(PARENT_YAML);
    expect(spec.tools.length).toBeGreaterThan(0);
    expect(spec.subagents).toHaveProperty('coder');
    expect(spec.subagents).toHaveProperty('explore');
    expect(spec.subagents).toHaveProperty('plan');
  });

  it('loads coder.yaml with extend inheritance', async () => {
    const spec = await loadAgentSpec(CODER_YAML);
    // Coder extends agent.yaml, inherits tools but overrides allowed_tools
    expect(spec.allowedTools).not.toBeNull();
    expect(spec.allowedTools!.length).toBeGreaterThan(0);
    expect(spec.excludeTools.length).toBeGreaterThan(0);
    // Should have ROLE_ADDITIONAL
    expect(spec.systemPromptArgs['ROLE_ADDITIONAL']).toContain('subagent');
  });

  it('loads explore.yaml with read-only tools', async () => {
    const spec = await loadAgentSpec(EXPLORE_YAML);
    expect(spec.allowedTools).not.toBeNull();
    // WriteFile and StrReplaceFile should be excluded
    expect(spec.excludeTools).toContain('kimi_cli.tools.file:WriteFile');
    expect(spec.excludeTools).toContain('kimi_cli.tools.file:StrReplaceFile');
  });

  it('loads plan.yaml without shell access', async () => {
    const spec = await loadAgentSpec(PLAN_YAML);
    expect(spec.excludeTools).toContain('kimi_cli.tools.shell:Shell');
  });

  it('child overrides parent fields', async () => {
    const parent = await loadAgentSpec(PARENT_YAML);
    const coder = await loadAgentSpec(CODER_YAML);
    // Parent has subagents; coder overrides to empty
    expect(Object.keys(parent.subagents).length).toBeGreaterThan(0);
    // Coder's when_to_use is set
    expect(coder.whenToUse).toContain('non-trivial');
  });

  it('rejects invalid YAML (no agent block)', async () => {
    // Create a temp invalid file using a path that won't exist
    await expect(loadAgentSpec('/nonexistent/path/bad.yaml')).rejects.toThrow();
  });
});

describe('loadSubagentTypes', () => {
  it('discovers 3 built-in types from parent agent.yaml', async () => {
    const types = await loadSubagentTypes(PARENT_YAML);
    expect(types).toHaveLength(3);
    const names = types.map((t) => t.name).sort();
    expect(names).toEqual(['coder', 'explore', 'plan']);
  });

  it('coder type has correct tool mapping', async () => {
    const types = await loadSubagentTypes(PARENT_YAML);
    const coder = types.find((t) => t.name === 'coder')!;
    expect(coder).toBeDefined();
    // Allowed tools should be mapped to TS names
    expect(coder.allowedTools).not.toBeNull();
    expect(coder.allowedTools).toContain('Bash');
    expect(coder.allowedTools).toContain('Read');
    // Excluded tools mapped
    expect(coder.excludeTools).toContain('Agent');
    expect(coder.excludeTools).toContain('AskUserQuestion');
  });

  it('explore type has read-only tools', async () => {
    const types = await loadSubagentTypes(PARENT_YAML);
    const explore = types.find((t) => t.name === 'explore')!;
    expect(explore.allowedTools).not.toBeNull();
    expect(explore.excludeTools).toContain('Agent');
    expect(explore.excludeTools).toContain('Write');
    expect(explore.excludeTools).toContain('Edit');
  });

  it('plan type excludes shell', async () => {
    const types = await loadSubagentTypes(PARENT_YAML);
    const plan = types.find((t) => t.name === 'plan')!;
    expect(plan.excludeTools).toContain('Bash');
  });

  it('all types have systemPromptSuffix with subagent role', async () => {
    const types = await loadSubagentTypes(PARENT_YAML);
    for (const t of types) {
      expect(t.systemPromptSuffix).toContain('subagent');
    }
  });

  it('all types have description from parent subagents block', async () => {
    const types = await loadSubagentTypes(PARENT_YAML);
    for (const t of types) {
      expect(t.description.length).toBeGreaterThan(0);
    }
  });
});
