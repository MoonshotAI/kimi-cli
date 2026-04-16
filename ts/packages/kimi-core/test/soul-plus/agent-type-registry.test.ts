/**
 * AgentTypeRegistry tests — type definitions + tool subset resolution.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AgentTypeRegistry } from '../../src/soul-plus/agent-type-registry.js';
import type { AgentTypeDefinition } from '../../src/soul-plus/agent-type-registry.js';
import type { Tool, ToolResult } from '../../src/soul/types.js';

function fakeTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: z.object({}),
    execute: async (): Promise<ToolResult> => ({ content: '' }),
  };
}

const CODER_DEF: AgentTypeDefinition = {
  name: 'coder',
  description: 'Code agent',
  whenToUse: 'For coding tasks',
  systemPromptSuffix: 'You are a coder subagent.',
  allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
  excludeTools: ['Agent', 'AskUserQuestion'],
  defaultModel: null,
};

const EXPLORE_DEF: AgentTypeDefinition = {
  name: 'explore',
  description: 'Explore agent',
  whenToUse: 'For exploration',
  systemPromptSuffix: 'You are an explore subagent.',
  allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
  excludeTools: ['Agent', 'Write', 'Edit'],
  defaultModel: null,
};

describe('AgentTypeRegistry', () => {
  describe('register + resolve', () => {
    it('round-trips a definition', () => {
      const registry = new AgentTypeRegistry();
      registry.register('coder', CODER_DEF);
      expect(registry.resolve('coder')).toEqual(CODER_DEF);
    });

    it('throws for unknown type', () => {
      const registry = new AgentTypeRegistry();
      expect(() => registry.resolve('unknown')).toThrow('Unknown agent type');
    });

    it('has() returns correct status', () => {
      const registry = new AgentTypeRegistry();
      registry.register('coder', CODER_DEF);
      expect(registry.has('coder')).toBe(true);
      expect(registry.has('explore')).toBe(false);
    });
  });

  describe('list', () => {
    it('lists all registered types', () => {
      const registry = new AgentTypeRegistry();
      registry.register('coder', CODER_DEF);
      registry.register('explore', EXPLORE_DEF);
      const types = registry.list();
      expect(types).toHaveLength(2);
      expect(types.map((t) => t.name).sort()).toEqual(['coder', 'explore']);
    });
  });

  describe('resolveToolSet', () => {
    const parentTools = [
      fakeTool('Bash'),
      fakeTool('Read'),
      fakeTool('Write'),
      fakeTool('Edit'),
      fakeTool('Grep'),
      fakeTool('Glob'),
      fakeTool('Agent'),
      fakeTool('AskUserQuestion'),
    ];

    it('filters to allowedTools whitelist', () => {
      const registry = new AgentTypeRegistry();
      registry.register('coder', CODER_DEF);
      const tools = registry.resolveToolSet('coder', parentTools);
      const names = tools.map((t) => t.name);
      expect(names).toContain('Bash');
      expect(names).toContain('Read');
      expect(names).not.toContain('Agent');
      expect(names).not.toContain('AskUserQuestion');
    });

    it('removes excludeTools from result', () => {
      const registry = new AgentTypeRegistry();
      registry.register('explore', EXPLORE_DEF);
      const tools = registry.resolveToolSet('explore', parentTools);
      const names = tools.map((t) => t.name);
      expect(names).not.toContain('Write');
      expect(names).not.toContain('Edit');
      expect(names).not.toContain('Agent');
    });

    it('inherits all parent tools when allowedTools is null', () => {
      const registry = new AgentTypeRegistry();
      const inheritDef: AgentTypeDefinition = {
        ...CODER_DEF,
        name: 'inherit',
        allowedTools: null,
        excludeTools: ['Agent'],
      };
      registry.register('inherit', inheritDef);
      const tools = registry.resolveToolSet('inherit', parentTools);
      const names = tools.map((t) => t.name);
      // Should have all except Agent
      expect(names).toContain('Bash');
      expect(names).toContain('AskUserQuestion');
      expect(names).not.toContain('Agent');
    });

    it('handles both allowedTools + excludeTools (whitelist then blacklist)', () => {
      const registry = new AgentTypeRegistry();
      // Allowed: Bash, Read, Write, Edit; Excluded: Write
      const combined: AgentTypeDefinition = {
        ...CODER_DEF,
        name: 'combined',
        allowedTools: ['Bash', 'Read', 'Write', 'Edit'],
        excludeTools: ['Write'],
      };
      registry.register('combined', combined);
      const tools = registry.resolveToolSet('combined', parentTools);
      const names = tools.map((t) => t.name);
      expect(names).toEqual(['Bash', 'Read', 'Edit']);
    });
  });

  describe('buildTypeDescriptions', () => {
    it('builds description lines for all types', () => {
      const registry = new AgentTypeRegistry();
      registry.register('coder', CODER_DEF);
      registry.register('explore', EXPLORE_DEF);
      const desc = registry.buildTypeDescriptions();
      expect(desc).toContain('- coder: Code agent');
      expect(desc).toContain('- explore: Explore agent');
      expect(desc).toContain('When to use:');
    });
  });
});
