/**
 * End-to-end agent system tests — Slice 3.1.
 *
 * Load agent.yaml → resolve inherits → expand template → get final system prompt.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_AGENT } from '../../src/agent/default-agent.js';
import { assembleSystemPrompt } from '../../src/agent/prompt-assembler.js';
import { AgentRegistry } from '../../src/agent/registry.js';
import type { TemplateContext } from '../../src/agent/types.js';

const context: TemplateContext = {
  workspaceDir: '/home/user/project',
  userName: 'alice',
  os: 'linux',
  date: '2025-06-01',
  kimiSkills: '- commit\n  - Description: Create commits',
  kimiHome: '/home/user/.kimi',
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `kimi-e2e-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('end-to-end agent system', () => {
  it('default agent loads and assembles a system prompt', () => {
    const registry = new AgentRegistry();
    const resolved = registry.resolve('default');

    const prompt = assembleSystemPrompt(resolved, context);
    expect(prompt).toContain('Kimi');
    expect(prompt).toContain('- commit');
    expect(prompt).toContain('Create commits');
  });

  it('custom agent inheriting from default gets full prompt', () => {
    // Create a custom agent on disk
    const customDir = join(tmpDir, 'custom');
    mkdirSync(customDir, { recursive: true });
    writeFileSync(
      join(customDir, 'agent.yaml'),
      `name: custom
description: Custom agent for Python
model: gpt-4
inherits: default`,
      'utf-8',
    );

    const registry = new AgentRegistry();
    registry.scanDirectory(tmpDir);

    const resolved = registry.resolve('custom');
    expect(resolved.name).toBe('custom');
    expect(resolved.model).toBe('gpt-4');
    // Inherited systemPrompt from default
    expect(resolved.systemPrompt).toBeDefined();

    const prompt = assembleSystemPrompt(resolved, context);
    expect(prompt).toContain('Kimi');
    expect(prompt).toContain('- commit');
  });

  it('custom agent with own system prompt overrides default', () => {
    const customDir = join(tmpDir, 'override');
    mkdirSync(customDir, { recursive: true });
    writeFileSync(
      join(customDir, 'agent.yaml'),
      'name: override\nsystem_prompt: |\n  You are a specialized agent in $' +
        '{WORKSPACE_DIR}.\n  Available skills: $' +
        '{KIMI_SKILLS}\ninherits: default',
      'utf-8',
    );

    const registry = new AgentRegistry();
    registry.scanDirectory(tmpDir);

    const resolved = registry.resolve('override');
    const prompt = assembleSystemPrompt(resolved, context);
    expect(prompt).toContain('You are a specialized agent in /home/user/project.');
    expect(prompt).toContain('Available skills: - commit');
  });

  it('agent with systemPromptPath loads from file', () => {
    const customDir = join(tmpDir, 'filepath');
    mkdirSync(customDir, { recursive: true });
    writeFileSync(join(customDir, 'system.md'), 'Hello ${USER_NAME}! OS: ${OS}', 'utf-8');
    writeFileSync(
      join(customDir, 'agent.yaml'),
      `name: filepath
system_prompt_path: ./system.md`,
      'utf-8',
    );

    const registry = new AgentRegistry();
    registry.scanDirectory(tmpDir);

    const resolved = registry.resolve('filepath');
    const prompt = assembleSystemPrompt(resolved, context);
    expect(prompt).toBe('Hello alice! OS: linux');
  });

  it('built-in default agent constant matches what registry returns', () => {
    const registry = new AgentRegistry();
    const fromRegistry = registry.get('default');
    expect(fromRegistry).toEqual(DEFAULT_AGENT);
  });
});
