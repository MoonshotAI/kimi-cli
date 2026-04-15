/**
 * Covers: ToolRegistry (v2 §9-F.5).
 *
 * Pins:
 *   - register / get / getOrThrow / list / has / unregister lifecycle
 *   - `__` namespace collision protection
 *   - duplicate name handling
 *   - Source precedence: builtin > sdk > mcp > plugin (Slice 4 audit m1)
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { Tool, ToolResult } from '../../src/soul/types.js';
import type { ToolConflict } from '../../src/tools/index.js';
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

  // ── m1 regression: source precedence (builtin > sdk > mcp > plugin) ──

  it('higher-precedence source wins over lower when registered second', () => {
    const conflicts: ToolConflict[] = [];
    const registry = new ToolRegistry({ onConflict: (c) => conflicts.push(c) });
    const pluginRead = makeTool('Read');
    const builtinRead = makeTool('Read');
    registry.register(pluginRead, 'plugin');
    registry.register(builtinRead, 'builtin');
    expect(registry.get('Read')).toBe(builtinRead);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual({
      name: 'Read',
      keptSource: 'builtin',
      droppedSource: 'plugin',
    });
  });

  it('lower-precedence source is dropped when higher already registered', () => {
    const onConflict = vi.fn();
    const registry = new ToolRegistry({ onConflict });
    const builtinRead = makeTool('Read');
    const pluginRead = makeTool('Read');
    registry.register(builtinRead, 'builtin');
    registry.register(pluginRead, 'plugin');
    expect(registry.get('Read')).toBe(builtinRead);
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(onConflict).toHaveBeenCalledWith({
      name: 'Read',
      keptSource: 'builtin',
      droppedSource: 'plugin',
    });
  });

  it('same-source collision still throws (plugin vs plugin)', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('Read'), 'plugin');
    expect(() => {
      registry.register(makeTool('Read'), 'plugin');
    }).toThrow();
  });

  it('default source is builtin — two defaultless registers still throw', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('Read'));
    expect(() => {
      registry.register(makeTool('Read'));
    }).toThrow();
  });

  it('mcp beats plugin, sdk beats mcp, builtin beats sdk', () => {
    const registry = new ToolRegistry();
    const plugin = makeTool('X');
    const mcp = makeTool('X');
    const sdk = makeTool('X');
    const builtin = makeTool('X');
    registry.register(plugin, 'plugin');
    expect(registry.get('X')).toBe(plugin);
    registry.register(mcp, 'mcp');
    expect(registry.get('X')).toBe(mcp);
    registry.register(sdk, 'sdk');
    expect(registry.get('X')).toBe(sdk);
    registry.register(builtin, 'builtin');
    expect(registry.get('X')).toBe(builtin);
  });
});
