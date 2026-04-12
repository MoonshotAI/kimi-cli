import { describe, expect, test } from 'vitest';

import type { MCPClient } from '../src/mcp-toolset.js';
import { MCPToolset } from '../src/mcp-toolset.js';

function createMockMCPClient(): MCPClient {
  return {
    async listTools() {
      return [
        {
          name: 'echo',
          description: 'Echoes input',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
        {
          name: 'add',
          description: 'Adds two numbers',
          inputSchema: {
            type: 'object',
            properties: { a: { type: 'number' }, b: { type: 'number' } },
            required: ['a', 'b'],
          },
        },
      ];
    },
    async callTool(name, args) {
      if (name === 'echo') {
        return {
          content: [{ type: 'text', text: String(args['text']) }],
          isError: false,
        };
      }
      if (name === 'add') {
        const a = args['a'] as number;
        const b = args['b'] as number;
        return {
          content: [{ type: 'text', text: String(a + b) }],
          isError: false,
        };
      }
      return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
    },
  };
}

describe('MCPToolset', () => {
  test('lists tools from MCP server', async () => {
    const client = createMockMCPClient();
    const toolset = await MCPToolset.connect(client);

    expect(toolset.tools).toHaveLength(2);
    expect(toolset.tools[0]?.name).toBe('echo');
    expect(toolset.tools[0]?.description).toBe('Echoes input');
    expect(toolset.tools[1]?.name).toBe('add');
  });

  test('handles tool call and returns ToolResult', async () => {
    const client = createMockMCPClient();
    const toolset = await MCPToolset.connect(client);

    const result = await toolset.handle({
      type: 'function',
      id: 'tc_001',
      function: { name: 'echo', arguments: '{"text":"hello"}' },
    });

    expect(result.toolCallId).toBe('tc_001');
    expect(result.returnValue.isError).toBe(false);
    expect(result.returnValue.output).toContain('hello');
  });

  test('handles add tool call', async () => {
    const client = createMockMCPClient();
    const toolset = await MCPToolset.connect(client);

    const result = await toolset.handle({
      type: 'function',
      id: 'tc_002',
      function: { name: 'add', arguments: '{"a":2,"b":3}' },
    });

    expect(result.returnValue.isError).toBe(false);
    expect(result.returnValue.output).toBe('5');
  });

  test('returns toolNotFoundError for unknown tool', async () => {
    const client = createMockMCPClient();
    const toolset = await MCPToolset.connect(client);

    const result = await toolset.handle({
      type: 'function',
      id: 'tc_003',
      function: { name: 'nonexistent', arguments: '{}' },
    });

    expect(result.returnValue.isError).toBe(true);
    expect(result.returnValue.message).toContain('not found');
  });

  test('returns toolParseError for invalid JSON', async () => {
    const client = createMockMCPClient();
    const toolset = await MCPToolset.connect(client);

    const result = await toolset.handle({
      type: 'function',
      id: 'tc_004',
      function: { name: 'echo', arguments: 'invalid json' },
    });

    expect(result.returnValue.isError).toBe(true);
  });

  test('validates inputSchema before calling remote tool', async () => {
    let callCount = 0;
    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: 'needs_x',
            description: 'Requires x',
            inputSchema: {
              type: 'object',
              properties: {
                x: { type: 'string' },
              },
              required: ['x'],
            },
          },
        ];
      },
      async callTool() {
        callCount += 1;
        return {
          content: [{ type: 'text', text: 'should not run' }],
          isError: false,
        };
      },
    };

    const toolset = await MCPToolset.connect(client);
    const result = await toolset.handle({
      type: 'function',
      id: 'tc_004b',
      function: { name: 'needs_x', arguments: '{}' },
    });

    expect(result.returnValue.isError).toBe(true);
    expect(result.returnValue.message).toContain('Error validating JSON arguments:');
    expect(result.returnValue.message).toContain('x');
    expect(result.returnValue.display).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'brief', text: 'Invalid arguments' }),
      ]),
    );
    expect(callCount).toBe(0);
  });

  test('handles MCP tool returning multiple content parts', async () => {
    const base = createMockMCPClient();
    const client: MCPClient = {
      listTools: base.listTools.bind(base),
      async callTool() {
        return {
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
            { type: 'image', data: 'base64data', mimeType: 'image/png' },
          ],
          isError: false,
        };
      },
    };
    const toolset = await MCPToolset.connect(client);
    const result = await toolset.handle({
      type: 'function',
      id: 'tc_005',
      function: { name: 'echo', arguments: '{"text":"hello"}' },
    });

    expect(result.returnValue.isError).toBe(false);
    expect(Array.isArray(result.returnValue.output)).toBe(true);
    const parts = result.returnValue.output as Array<{ type: string }>;
    expect(parts).toHaveLength(3);
    expect(parts[0]?.type).toBe('text');
    expect(parts[2]?.type).toBe('image_url');
  });

  test('propagates isError=true from MCP tool result', async () => {
    const base = createMockMCPClient();
    const client: MCPClient = {
      listTools: base.listTools.bind(base),
      async callTool() {
        return {
          content: [{ type: 'text', text: 'tool failed' }],
          isError: true,
        };
      },
    };
    const toolset = await MCPToolset.connect(client);
    const result = await toolset.handle({
      type: 'function',
      id: 'tc_006',
      function: { name: 'echo', arguments: '{"text":"hello"}' },
    });
    expect(result.returnValue.isError).toBe(true);
    expect(result.returnValue.output).toBe('tool failed');
  });

  test('returns toolRuntimeError when client.callTool throws', async () => {
    const base = createMockMCPClient();
    const client: MCPClient = {
      listTools: base.listTools.bind(base),
      async callTool() {
        throw new Error('connection lost');
      },
    };
    const toolset = await MCPToolset.connect(client);
    const result = await toolset.handle({
      type: 'function',
      id: 'tc_007',
      function: { name: 'echo', arguments: '{"text":"hello"}' },
    });
    expect(result.returnValue.isError).toBe(true);
    expect(result.returnValue.message).toContain('connection lost');
  });

  test('accepts null arguments and treats them as empty object', async () => {
    let receivedArgs: Record<string, unknown> | null = null;
    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: 'ping',
            description: 'No-op tool',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
        ];
      },
      async callTool(_name, args) {
        receivedArgs = args;
        return {
          content: [{ type: 'text', text: 'pong' }],
          isError: false,
        };
      },
    };
    const toolset = await MCPToolset.connect(client);

    const result = await toolset.handle({
      type: 'function',
      id: 'tc_008',
      function: { name: 'ping', arguments: null },
    });
    expect(result.returnValue.isError).toBe(false);
    expect(receivedArgs).toEqual({});
  });
});
