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

  // ── Slice 7.2 (决策 #100) — async / prefixed paths for MCP ──────────────

  describe('registerBatch / unregisterByPrefix / onChanged (Phase 7)', () => {
    it('registerBatch registers every tool under the given prefix', async () => {
      const registry = new ToolRegistry();
      await registry.registerBatch('mcp__svr__', [
        makeTool('mcp__svr__ping'),
        makeTool('mcp__svr__pong'),
      ]);
      expect(registry.has('mcp__svr__ping')).toBe(true);
      expect(registry.has('mcp__svr__pong')).toBe(true);
    });

    it('registerBatch atomically replaces prior tools with the same prefix', async () => {
      const registry = new ToolRegistry();
      await registry.registerBatch('mcp__svr__', [
        makeTool('mcp__svr__old-a'),
        makeTool('mcp__svr__old-b'),
      ]);
      await registry.registerBatch('mcp__svr__', [makeTool('mcp__svr__new')]);
      expect(registry.has('mcp__svr__old-a')).toBe(false);
      expect(registry.has('mcp__svr__old-b')).toBe(false);
      expect(registry.has('mcp__svr__new')).toBe(true);
    });

    it('registerBatch does not touch tools with a different prefix', async () => {
      const registry = new ToolRegistry();
      registry.register(makeTool('Read'));
      await registry.registerBatch('mcp__svr__', [makeTool('mcp__svr__a')]);
      await registry.registerBatch('mcp__svr__', [makeTool('mcp__svr__b')]);
      expect(registry.has('Read')).toBe(true);
      expect(registry.has('mcp__svr__b')).toBe(true);
    });

    it('unregisterByPrefix removes every tool with the given prefix', () => {
      const registry = new ToolRegistry();
      registry.register(makeTool('mcp__svr__a'), 'mcp');
      registry.register(makeTool('mcp__svr__b'), 'mcp');
      registry.register(makeTool('Read'));
      registry.unregisterByPrefix('mcp__svr__');
      expect(registry.has('mcp__svr__a')).toBe(false);
      expect(registry.has('mcp__svr__b')).toBe(false);
      expect(registry.has('Read')).toBe(true);
    });

    it('onChanged fires with added / removed name sets after registerBatch', async () => {
      const registry = new ToolRegistry();
      const changes: Array<{ added: string[]; removed: string[] }> = [];
      registry.onChanged = (c) => changes.push(c);
      await registry.registerBatch('mcp__svr__', [makeTool('mcp__svr__ping')]);
      expect(changes).toHaveLength(1);
      expect(changes[0]?.added).toContain('mcp__svr__ping');
      expect(changes[0]?.removed ?? []).not.toContain('mcp__svr__ping');
    });

    it('onChanged fires with removed names after unregisterByPrefix', () => {
      const registry = new ToolRegistry();
      registry.register(makeTool('mcp__svr__a'), 'mcp');
      registry.register(makeTool('mcp__svr__b'), 'mcp');
      const changes: Array<{ added: string[]; removed: string[] }> = [];
      registry.onChanged = (c) => changes.push(c);
      registry.unregisterByPrefix('mcp__svr__');
      expect(changes).toHaveLength(1);
      expect(changes[0]?.removed).toEqual(expect.arrayContaining(['mcp__svr__a', 'mcp__svr__b']));
    });

    it('registerBatch dedupes by name with last-wins (M-2)', async () => {
      const registry = new ToolRegistry();
      const first = makeTool('mcp__svr__dup');
      const second = makeTool('mcp__svr__dup');
      // Should NOT throw despite the two identical names in one batch.
      await registry.registerBatch('mcp__svr__', [first, second]);
      // Last entry wins.
      expect(registry.get('mcp__svr__dup')).toBe(second);
    });

    it('concurrent registerBatch calls do not drop tools', async () => {
      const registry = new ToolRegistry();
      await Promise.all([
        registry.registerBatch('mcp__a__', [makeTool('mcp__a__one'), makeTool('mcp__a__two')]),
        registry.registerBatch('mcp__b__', [makeTool('mcp__b__one'), makeTool('mcp__b__two')]),
      ]);
      expect(registry.has('mcp__a__one')).toBe(true);
      expect(registry.has('mcp__a__two')).toBe(true);
      expect(registry.has('mcp__b__one')).toBe(true);
      expect(registry.has('mcp__b__two')).toBe(true);
    });
  });
});
