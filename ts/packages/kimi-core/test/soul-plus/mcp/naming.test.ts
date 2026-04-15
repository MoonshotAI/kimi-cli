/**
 * MCP naming + ToolRegistry interaction — Slice 2.6.
 *
 * The v2 naming rule (`mcp__<server>__<tool>`) lets two MCP servers
 * expose tools with the same inner name without collision. A builtin
 * tool should always win against an MCP tool on the same name via
 * the ToolRegistry source precedence from Slice 4.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { MCPClient } from '../../../src/soul-plus/mcp/client.js';
import { MCPManager, mcpToolName } from '../../../src/soul-plus/mcp/index.js';
import type { Tool } from '../../../src/soul/types.js';
import { ToolRegistry } from '../../../src/tools/registry.js';

class NoopClient implements MCPClient {
  constructor(public readonly tools: Array<{ name: string; description: string }>) {}
  async connect(): Promise<void> {}
  async listTools() {
    return this.tools.map((t) => ({ ...t, inputSchema: {} }));
  }
  async callTool(
    _name: string,
    _args: Record<string, unknown>,
    _options?: { signal?: AbortSignal },
  ) {
    return { content: [{ type: 'text', text: '' }], isError: false };
  }
  async close(): Promise<void> {}
}

describe('MCP tool naming', () => {
  it('keeps two servers with same-named tools separate under mcp__ prefix', async () => {
    const manager = new MCPManager({
      config: {
        mcpServers: {
          s1: { command: 'noop' },
          s2: { command: 'noop' },
        },
      },
      clientFactory: () =>
        new NoopClient([{ name: 'get_files', description: '' }]) as unknown as MCPClient,
    });
    await manager.loadAll();
    const names = manager
      .getTools()
      .map((t) => t.name)
      .toSorted();
    expect(names).toEqual([mcpToolName('s1', 'get_files'), mcpToolName('s2', 'get_files')]);
  });
});

describe('ToolRegistry × MCP precedence', () => {
  const builtinTool: Tool = {
    name: 'mcp__files__list',
    description: 'builtin impostor (should never happen in practice)',
    inputSchema: z.unknown(),
    execute: async () => ({ content: [] }),
  };

  it('drops an MCP tool that collides with a builtin of the same name', () => {
    const conflicts: Array<{ kept: string; dropped: string }> = [];
    const registry = new ToolRegistry({
      onConflict: (c) => conflicts.push({ kept: c.keptSource, dropped: c.droppedSource }),
    });
    registry.register(builtinTool, 'builtin');
    registry.register(
      {
        name: 'mcp__files__list',
        description: 'mcp tool',
        inputSchema: z.unknown(),
        execute: async () => ({ content: [] }),
      },
      'mcp',
    );
    expect(registry.get('mcp__files__list')).toBe(builtinTool);
    expect(conflicts).toEqual([{ kept: 'builtin', dropped: 'mcp' }]);
  });

  it('registers a non-colliding MCP tool without a conflict event', () => {
    const conflicts: unknown[] = [];
    const registry = new ToolRegistry({ onConflict: (c) => conflicts.push(c) });
    registry.register(
      {
        name: 'mcp__files__read',
        description: 'mcp',
        inputSchema: z.unknown(),
        execute: async () => ({ content: [] }),
      },
      'mcp',
    );
    expect(registry.has('mcp__files__read')).toBe(true);
    expect(conflicts).toHaveLength(0);
  });
});
