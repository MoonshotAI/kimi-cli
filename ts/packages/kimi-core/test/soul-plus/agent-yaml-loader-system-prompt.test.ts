/**
 * AgentYamlLoader system prompt tests — system.md loading + nunjucks template
 * variable substitution.
 *
 * Slice 6.0 red-bar tests. All tests should FAIL until implementation lands.
 *
 * Tests that `loadSubagentTypes()` reads `system_prompt_path`, applies
 * nunjucks rendering with built-in variables (`${KIMI_OS}`,
 * `${KIMI_SHELL}`, `${KIMI_WORK_DIR}`), and produces a full
 * `systemPromptSuffix` instead of the bare `ROLE_ADDITIONAL` string.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadSubagentTypes } from '../../src/soul-plus/agent-yaml-loader.js';

// The real YAML files in the project
const AGENTS_DIR = resolve(__dirname, '../../agents/default');
const PARENT_YAML = resolve(AGENTS_DIR, 'agent.yaml');

// ── Full system.md loading via real project files ────────────────────

describe('loadSubagentTypes with system.md', () => {
  it('systemPromptSuffix contains full system prompt (not just ROLE_ADDITIONAL)', async () => {
    const types = await loadSubagentTypes(PARENT_YAML);
    const coder = types.find((t) => t.name === 'coder')!;
    expect(coder).toBeDefined();

    // After system.md loading, the suffix should contain content from
    // system.md (like "Kimi Code CLI") beyond just the ROLE_ADDITIONAL
    expect(coder.systemPromptSuffix).toContain('Kimi Code CLI');
  });

  it('ROLE_ADDITIONAL is substituted into system.md template', async () => {
    const types = await loadSubagentTypes(PARENT_YAML);
    const coder = types.find((t) => t.name === 'coder')!;

    // The ROLE_ADDITIONAL content from coder.yaml should be present
    expect(coder.systemPromptSuffix).toContain('subagent');
    // And the full system.md content should also be present (not just ROLE_ADDITIONAL)
    expect(coder.systemPromptSuffix).toContain('Prompt and Tool Use');
  });

  it('explore type includes its specific ROLE_ADDITIONAL in the full prompt', async () => {
    const types = await loadSubagentTypes(PARENT_YAML);
    const explore = types.find((t) => t.name === 'explore')!;

    // Explore's ROLE_ADDITIONAL mentions "codebase exploration specialist"
    expect(explore.systemPromptSuffix).toContain('exploration specialist');
    // And also the base system.md content
    expect(explore.systemPromptSuffix).toContain('Kimi Code CLI');
  });
});

// ── Built-in variable substitution ───────────────────────────────────

describe('built-in variable substitution', () => {
  it('${KIMI_OS} is replaced with actual OS', async () => {
    const types = await loadSubagentTypes(PARENT_YAML);
    const coder = types.find((t) => t.name === 'coder')!;

    // After template rendering, the literal "${KIMI_OS}" should NOT appear
    expect(coder.systemPromptSuffix).not.toContain('${KIMI_OS}');
    // Instead, a real OS name should be present (e.g. "macOS", "Linux", "Windows")
    // We check that the "Operating System" section has some real value
    expect(coder.systemPromptSuffix).toMatch(/running on \*\*\w+/);
  });

  it('${KIMI_SHELL} is replaced', async () => {
    const types = await loadSubagentTypes(PARENT_YAML);
    const coder = types.find((t) => t.name === 'coder')!;

    // The system.md template contains "${KIMI_SHELL}" — after rendering,
    // it should be replaced with the actual shell (e.g. "bash", "zsh").
    // The rendered prompt must contain the "Operating System" section from
    // system.md (proving system.md was loaded AND template vars replaced).
    expect(coder.systemPromptSuffix).toContain('Shell tool executes commands using');
    expect(coder.systemPromptSuffix).not.toContain('${KIMI_SHELL}');
  });

  it('${KIMI_WORK_DIR} is replaced', async () => {
    const types = await loadSubagentTypes(PARENT_YAML);
    const coder = types.find((t) => t.name === 'coder')!;

    // system.md has "The current working directory is `${KIMI_WORK_DIR}`"
    // After rendering, this section should be present with a real path.
    expect(coder.systemPromptSuffix).toContain('current working directory is');
    expect(coder.systemPromptSuffix).not.toContain('${KIMI_WORK_DIR}');
  });
});

// ── Conditional blocks ───────────────────────────────────────────────

describe('conditional blocks', () => {
  it('Windows-specific block is not rendered on non-Windows', async () => {
    // On macOS/Linux, the Windows warning should not appear
    if (process.platform !== 'win32') {
      const types = await loadSubagentTypes(PARENT_YAML);
      const coder = types.find((t) => t.name === 'coder')!;

      // First, prove system.md was loaded (the "Operating System" section exists)
      expect(coder.systemPromptSuffix).toContain('Operating System');
      // The system.md has: {% if KIMI_OS == "Windows" %} ... {% endif %}
      // On non-Windows, the "IMPORTANT: You are on Windows" block should be absent
      expect(coder.systemPromptSuffix).not.toContain('IMPORTANT: You are on Windows');
    }
  });
});

// ── Fallback when system.md is missing ───────────────────────────────

describe('system.md fallback', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kimi-sysprompt-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('falls back to ROLE_ADDITIONAL when system_prompt_path file is missing', async () => {
    // Create a minimal parent agent.yaml that points to a non-existent system.md
    const parentYaml = join(tmpDir, 'agent.yaml');
    await writeFile(
      parentYaml,
      `version: 1
agent:
  name: "test-parent"
  system_prompt_path: ./nonexistent-system.md
  system_prompt_args:
    ROLE_ADDITIONAL: ""
  tools:
    - "kimi_cli.tools.shell:Shell"
  subagents:
    test-child:
      path: ./child.yaml
      description: "test child agent"
`,
    );

    // Create the child yaml
    const childYaml = join(tmpDir, 'child.yaml');
    await writeFile(
      childYaml,
      `version: 1
agent:
  extend: ./agent.yaml
  system_prompt_args:
    ROLE_ADDITIONAL: "You are a test subagent with fallback behavior."
  when_to_use: "for testing"
  allowed_tools:
    - "kimi_cli.tools.shell:Shell"
  exclude_tools: []
  subagents:
`,
    );

    const types = await loadSubagentTypes(parentYaml);
    expect(types).toHaveLength(1);
    const child = types[0]!;

    // When system.md doesn't exist, should degrade to ROLE_ADDITIONAL only
    expect(child.systemPromptSuffix).toContain('test subagent with fallback behavior');
    // Should NOT contain system.md content (since the file doesn't exist)
    expect(child.systemPromptSuffix).not.toContain('Kimi Code CLI');
  });

  it('falls back gracefully when system_prompt_path is not specified at all', async () => {
    // Create a parent that has no system_prompt_path
    const parentYaml = join(tmpDir, 'agent.yaml');
    await writeFile(
      parentYaml,
      `version: 1
agent:
  name: "test-no-path"
  system_prompt_args:
    ROLE_ADDITIONAL: ""
  tools:
    - "kimi_cli.tools.shell:Shell"
  subagents:
    fallback-child:
      path: ./fallback.yaml
      description: "child without system prompt path"
`,
    );

    const fallbackYaml = join(tmpDir, 'fallback.yaml');
    await writeFile(
      fallbackYaml,
      `version: 1
agent:
  extend: ./agent.yaml
  system_prompt_args:
    ROLE_ADDITIONAL: "Bare ROLE_ADDITIONAL only."
  when_to_use: "testing fallback"
  allowed_tools:
    - "kimi_cli.tools.shell:Shell"
  exclude_tools: []
  subagents:
`,
    );

    const types = await loadSubagentTypes(parentYaml);
    expect(types).toHaveLength(1);
    const child = types[0]!;

    // Without system_prompt_path, ROLE_ADDITIONAL should be the entire suffix
    expect(child.systemPromptSuffix).toBe('Bare ROLE_ADDITIONAL only.');
  });
});
