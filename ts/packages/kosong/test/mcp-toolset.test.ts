import { describe, expect, test } from 'vitest';

import type { MCPClient, MCPContentBlock } from '../src/mcp-toolset.js';
import { convertMCPContentBlock, MCPToolset } from '../src/mcp-toolset.js';

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

  test('rejects JSON arguments that parse to a non-object value (number)', async () => {
    const client = createMockMCPClient();
    const toolset = await MCPToolset.connect(client);

    const result = await toolset.handle({
      type: 'function',
      id: 'tc_nonobj_num',
      function: { name: 'echo', arguments: '42' },
    });

    expect(result.returnValue.isError).toBe(true);
    expect(result.returnValue.message).toContain('Tool arguments must be a JSON object');
  });

  test('rejects JSON arguments that parse to an array', async () => {
    const client = createMockMCPClient();
    const toolset = await MCPToolset.connect(client);

    const result = await toolset.handle({
      type: 'function',
      id: 'tc_nonobj_arr',
      function: { name: 'echo', arguments: '[1,2,3]' },
    });

    expect(result.returnValue.isError).toBe(true);
    expect(result.returnValue.message).toContain('Tool arguments must be a JSON object');
  });

  test('rejects JSON arguments that parse to null', async () => {
    const client = createMockMCPClient();
    const toolset = await MCPToolset.connect(client);

    const result = await toolset.handle({
      type: 'function',
      id: 'tc_nonobj_null',
      function: { name: 'echo', arguments: 'null' },
    });

    expect(result.returnValue.isError).toBe(true);
    expect(result.returnValue.message).toContain('Tool arguments must be a JSON object');
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

describe('convertMCPContentBlock', () => {
  test('converts text block to TextPart', () => {
    const block: MCPContentBlock = { type: 'text', text: 'hello' };
    expect(convertMCPContentBlock(block)).toEqual({ type: 'text', text: 'hello' });
  });

  test('converts image block with mimeType to image data URI', () => {
    const block: MCPContentBlock = { type: 'image', data: 'AAA', mimeType: 'image/jpeg' };
    expect(convertMCPContentBlock(block)).toEqual({
      type: 'image_url',
      imageUrl: { url: 'data:image/jpeg;base64,AAA' },
    });
  });

  test('image block without mimeType defaults to image/png', () => {
    const block: MCPContentBlock = { type: 'image', data: 'AAA' };
    expect(convertMCPContentBlock(block)).toEqual({
      type: 'image_url',
      imageUrl: { url: 'data:image/png;base64,AAA' },
    });
  });

  test('converts audio block to AudioURLPart with audio/mpeg default', () => {
    const block: MCPContentBlock = { type: 'audio', data: 'BBB' };
    expect(convertMCPContentBlock(block)).toEqual({
      type: 'audio_url',
      audioUrl: { url: 'data:audio/mpeg;base64,BBB' },
    });
  });

  test('converts audio block with custom mimeType', () => {
    const block: MCPContentBlock = { type: 'audio', data: 'BBB', mimeType: 'audio/wav' };
    expect(convertMCPContentBlock(block)).toEqual({
      type: 'audio_url',
      audioUrl: { url: 'data:audio/wav;base64,BBB' },
    });
  });

  test('converts resource block with image/* mimeType to ImageURLPart', () => {
    const block: MCPContentBlock = { type: 'resource', data: 'III', mimeType: 'image/webp' };
    expect(convertMCPContentBlock(block)).toEqual({
      type: 'image_url',
      imageUrl: { url: 'data:image/webp;base64,III' },
    });
  });

  test('converts resource block with audio/* mimeType to AudioURLPart', () => {
    const block: MCPContentBlock = { type: 'resource', data: 'AUD', mimeType: 'audio/wav' };
    expect(convertMCPContentBlock(block)).toEqual({
      type: 'audio_url',
      audioUrl: { url: 'data:audio/wav;base64,AUD' },
    });
  });

  test('converts resource block with video/* mimeType to VideoURLPart', () => {
    const block: MCPContentBlock = { type: 'resource', data: 'VID', mimeType: 'video/mp4' };
    expect(convertMCPContentBlock(block)).toEqual({
      type: 'video_url',
      videoUrl: { url: 'data:video/mp4;base64,VID' },
    });
  });

  test('returns null for resource block with unsupported mimeType', () => {
    const block: MCPContentBlock = { type: 'resource', data: 'XXX', mimeType: 'application/pdf' };
    expect(convertMCPContentBlock(block)).toBeNull();
  });

  test('resource block defaults to application/octet-stream and returns null', () => {
    const block: MCPContentBlock = { type: 'resource', data: 'XXX' };
    expect(convertMCPContentBlock(block)).toBeNull();
  });

  test('converts resource_link with image/* mimeType to ImageURLPart with URL', () => {
    const block: MCPContentBlock = {
      type: 'resource_link',
      uri: 'https://example.com/img.png',
      mimeType: 'image/png',
    };
    expect(convertMCPContentBlock(block)).toEqual({
      type: 'image_url',
      imageUrl: { url: 'https://example.com/img.png' },
    });
  });

  test('converts resource_link with audio/* mimeType to AudioURLPart with URL', () => {
    const block: MCPContentBlock = {
      type: 'resource_link',
      uri: 'https://example.com/audio.mp3',
      mimeType: 'audio/mpeg',
    };
    expect(convertMCPContentBlock(block)).toEqual({
      type: 'audio_url',
      audioUrl: { url: 'https://example.com/audio.mp3' },
    });
  });

  test('converts resource_link with video/* mimeType to VideoURLPart with URL', () => {
    const block: MCPContentBlock = {
      type: 'resource_link',
      uri: 'https://example.com/video.mp4',
      mimeType: 'video/mp4',
    };
    expect(convertMCPContentBlock(block)).toEqual({
      type: 'video_url',
      videoUrl: { url: 'https://example.com/video.mp4' },
    });
  });

  test('returns null for resource_link with unsupported mimeType', () => {
    const block: MCPContentBlock = {
      type: 'resource_link',
      uri: 'https://example.com/file.bin',
      mimeType: 'application/octet-stream',
    };
    expect(convertMCPContentBlock(block)).toBeNull();
  });

  test('returns null for unknown block type', () => {
    const block: MCPContentBlock = { type: 'fancy_new_type', text: 'whatever' };
    expect(convertMCPContentBlock(block)).toBeNull();
  });

  test('returns null for text block missing text field', () => {
    const block: MCPContentBlock = { type: 'text' };
    expect(convertMCPContentBlock(block)).toBeNull();
  });

  test('returns null for image block missing data field', () => {
    const block: MCPContentBlock = { type: 'image', mimeType: 'image/png' };
    expect(convertMCPContentBlock(block)).toBeNull();
  });
});
