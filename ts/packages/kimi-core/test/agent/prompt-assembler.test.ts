/**
 * Prompt assembler tests — Slice 3.1.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentSpecError } from '../../src/agent/errors.js';
import { assembleSystemPrompt } from '../../src/agent/prompt-assembler.js';
import type { AgentSpec } from '../../src/agent/types.js';
import type { TemplateContext } from '../../src/agent/types.js';

const context: TemplateContext = {
  workspaceDir: '/home/user/project',
  userName: 'alice',
  os: 'linux',
  date: '2025-01-15',
  kimiSkills: '- commit\n- review',
  kimiHome: '/home/user/.kimi',
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `kimi-prompt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('assembleSystemPrompt', () => {
  it('uses inline systemPrompt and expands variables', () => {
    const spec: AgentSpec = {
      name: 'test',
      systemPrompt: 'Hello ${USER_NAME}, you are on ${OS}.',
    };
    const result = assembleSystemPrompt(spec, context);
    expect(result).toBe('Hello alice, you are on linux.');
  });

  it('reads systemPromptPath from file and expands variables', () => {
    const promptFile = join(tmpDir, 'system.md');
    writeFileSync(promptFile, 'Skills:\n${KIMI_SKILLS}\nDir: ${WORKSPACE_DIR}', 'utf-8');

    const spec: AgentSpec = {
      name: 'test',
      systemPromptPath: promptFile,
    };
    const result = assembleSystemPrompt(spec, context);
    expect(result).toBe('Skills:\n- commit\n- review\nDir: /home/user/project');
  });

  it('prefers systemPrompt over systemPromptPath', () => {
    const promptFile = join(tmpDir, 'system.md');
    writeFileSync(promptFile, 'FILE CONTENT', 'utf-8');

    const spec: AgentSpec = {
      name: 'test',
      systemPrompt: 'INLINE CONTENT',
      systemPromptPath: promptFile,
    };
    const result = assembleSystemPrompt(spec, context);
    expect(result).toBe('INLINE CONTENT');
  });

  it('throws when neither systemPrompt nor systemPromptPath is set', () => {
    const spec: AgentSpec = { name: 'empty' };
    expect(() => assembleSystemPrompt(spec, context)).toThrow(AgentSpecError);
  });

  it('throws when systemPromptPath file does not exist', () => {
    const spec: AgentSpec = {
      name: 'test',
      systemPromptPath: join(tmpDir, 'nonexistent.md'),
    };
    expect(() => assembleSystemPrompt(spec, context)).toThrow(AgentSpecError);
  });
});
