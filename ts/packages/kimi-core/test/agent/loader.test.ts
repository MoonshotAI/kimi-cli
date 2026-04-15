/**
 * Agent loader tests — Slice 3.1.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentSpecError } from '../../src/agent/errors.js';
import { loadAgentFile, parseAgentSpec } from '../../src/agent/loader.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `kimi-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseAgentSpec', () => {
  it('parses minimal agent YAML', () => {
    const spec = parseAgentSpec('name: test\ndescription: A test agent');
    expect(spec.name).toBe('test');
    expect(spec.description).toBe('A test agent');
  });

  it('parses all fields', () => {
    const yaml = `name: full
description: Full agent
model: gpt-4
thinking_mode: auto
thinking_effort: high
inherits: default
tools:
  include:
    - shell
  exclude:
    - rm_rf
skills:
  include:
    - commit`;
    const spec = parseAgentSpec(yaml);
    expect(spec.name).toBe('full');
    expect(spec.model).toBe('gpt-4');
    expect(spec.thinkingMode).toBe('auto');
    expect(spec.thinkingEffort).toBe('high');
    expect(spec.inherits).toBe('default');
    expect(spec.tools).toEqual({ include: ['shell'], exclude: ['rm_rf'] });
    expect(spec.skills).toEqual({ include: ['commit'], exclude: undefined });
  });

  it('supports system_prompt inline', () => {
    const yaml = `name: inline
system_prompt: |
  Hello world`;
    const spec = parseAgentSpec(yaml);
    expect(spec.systemPrompt).toBe('Hello world\n');
  });

  it('throws on missing name', () => {
    expect(() => parseAgentSpec('description: no name')).toThrow(AgentSpecError);
  });

  it('throws on empty name', () => {
    expect(() => parseAgentSpec('name: ""')).toThrow(AgentSpecError);
  });

  it('throws on invalid thinking_mode', () => {
    expect(() => parseAgentSpec('name: bad\nthinking_mode: invalid')).toThrow(AgentSpecError);
  });
});

describe('loadAgentFile', () => {
  it('loads a valid agent.yaml from disk', () => {
    const agentFile = join(tmpDir, 'agent.yaml');
    writeFileSync(agentFile, 'name: disk-agent\nmodel: test-model', 'utf-8');

    const spec = loadAgentFile(agentFile);
    expect(spec.name).toBe('disk-agent');
    expect(spec.model).toBe('test-model');
  });

  it('resolves systemPromptPath relative to agent.yaml directory', () => {
    const agentFile = join(tmpDir, 'agent.yaml');
    writeFileSync(agentFile, 'name: path-test\nsystem_prompt_path: ./system.md', 'utf-8');
    writeFileSync(join(tmpDir, 'system.md'), 'Hello ${USER_NAME}', 'utf-8');

    const spec = loadAgentFile(agentFile);
    expect(spec.systemPromptPath).toBe(join(tmpDir, 'system.md'));
  });

  it('throws on nonexistent file', () => {
    expect(() => loadAgentFile(join(tmpDir, 'nope.yaml'))).toThrow(AgentSpecError);
  });

  it('throws on invalid YAML', () => {
    const agentFile = join(tmpDir, 'agent.yaml');
    writeFileSync(agentFile, '  bad: indent', 'utf-8');
    expect(() => loadAgentFile(agentFile)).toThrow(AgentSpecError);
  });
});
