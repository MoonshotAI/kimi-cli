/**
 * Covers: ToolRegistry (v2 §9-F.5).
 *
 * Pins:
 *   - register / get / getOrThrow / list / has / unregister lifecycle
 *   - `__` namespace collision protection
 *   - duplicate name handling
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Tool, ToolResult } from '../../src/soul/types.js';
import { ToolRegistry } from '../../src/tools/index.js';

function makeTool(name: string): Tool {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: z.object({}),
    execute: async (): Promise<ToolResult> => ({ content: 'ok' }),
  };
}

describe('ToolRegistry', () => {
  it('register + get round-trips a tool', () => {
    const registry = new ToolRegistry();
    const tool = makeTool('Read');
    registry.register(tool);
    expect(registry.get('Read')).toBe(tool);
  });

  it('get returns undefined for unregistered name', () => {
    const registry = new ToolRegistry();
    expect(registry.get('NonExistent')).toBeUndefined();
  });

  it('getOrThrow throws for unregistered name', () => {
    const registry = new ToolRegistry();
    expect(() => registry.getOrThrow('Missing')).toThrow();
  });

  it('list returns all registered tools', () => {
    const registry = new ToolRegistry();
    const read = makeTool('Read');
    const write = makeTool('Write');
    registry.register(read);
    registry.register(write);
    const listed = registry.list();
    expect(listed).toHaveLength(2);
    expect(listed).toContain(read);
    expect(listed).toContain(write);
  });

  it('has returns true for registered, false for unregistered', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('Bash'));
    expect(registry.has('Bash')).toBe(true);
    expect(registry.has('NonExistent')).toBe(false);
  });

  it('unregister removes a tool', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('Edit'));
    expect(registry.has('Edit')).toBe(true);
    registry.unregister('Edit');
    expect(registry.has('Edit')).toBe(false);
    expect(registry.get('Edit')).toBeUndefined();
  });

  it('duplicate register with same name throws or replaces (conflict handling)', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('Read'));
    // Second register with same name should throw to prevent accidental override
    expect(() => {
      registry.register(makeTool('Read'));
    }).toThrow();
  });

  it('__ namespace tools do not collide with non-namespaced tools', () => {
    const registry = new ToolRegistry();
    const builtin = makeTool('greet');
    const plugin = makeTool('plugin__my_plugin__greet');
    registry.register(builtin);
    registry.register(plugin);
    expect(registry.get('greet')).toBe(builtin);
    expect(registry.get('plugin__my_plugin__greet')).toBe(plugin);
    expect(registry.list()).toHaveLength(2);
  });

  it('list returns empty array when no tools registered', () => {
    const registry = new ToolRegistry();
    expect(registry.list()).toEqual([]);
  });
});
