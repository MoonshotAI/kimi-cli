import { describe, expect, it } from 'vitest';

import type { ToolCall } from '../src/message.js';
import { SimpleToolset } from '../src/simple-toolset.js';
import type { JsonType, ToolReturnValue } from '../src/tool.js';
import { toolOk } from '../src/tool.js';

// ── Helpers ───────────────────────────────────────────────────────────

function makeToolCall(id: string, name: string, args: string | null): ToolCall {
  return {
    type: 'function',
    id,
    function: { name, arguments: args },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('SimpleToolset', () => {
  it('handle() invokes the registered handler and returns ToolResult', async () => {
    const toolset = new SimpleToolset();
    toolset.add(
      { name: 'plus', description: 'Add two numbers', parameters: {} },
      async (args: JsonType): Promise<ToolReturnValue> => {
        const obj = args as Record<string, JsonType>;
        const a = obj['a'] as number;
        const b = obj['b'] as number;
        return toolOk({ output: String(a + b) });
      },
    );

    const tc = makeToolCall('1', 'plus', '{"a": 1, "b": 2}');
    const result = await toolset.handle(tc);

    expect(result.toolCallId).toBe('1');
    expect(result.returnValue.isError).toBe(false);
    expect(result.returnValue.output).toBe('3');
  });

  it('handle() returns toolNotFoundError for unknown tool', async () => {
    const toolset = new SimpleToolset();

    const tc = makeToolCall('1', 'not_found', null);
    const result = await toolset.handle(tc);

    expect(result.toolCallId).toBe('1');
    expect(result.returnValue.isError).toBe(true);
    expect(result.returnValue.message).toContain('not_found');
  });

  it('handle() returns toolParseError on invalid JSON', async () => {
    const toolset = new SimpleToolset();
    toolset.add(
      { name: 'test', description: 'test', parameters: {} },
      async (): Promise<ToolReturnValue> => toolOk({ output: 'ok' }),
    );

    const tc = makeToolCall('1', 'test', '{invalid json}');
    const result = await toolset.handle(tc);

    expect(result.toolCallId).toBe('1');
    expect(result.returnValue.isError).toBe(true);
    expect(result.returnValue.message).toContain('Error parsing JSON arguments:');
    expect(result.returnValue.display).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'brief', text: 'Invalid arguments' }),
      ]),
    );
  });

  it('handle() returns toolRuntimeError when handler throws', async () => {
    const toolset = new SimpleToolset();
    toolset.add(
      { name: 'explode', description: 'Throws', parameters: {} },
      async (): Promise<ToolReturnValue> => {
        throw new Error('boom');
      },
    );

    const tc = makeToolCall('1', 'explode', '{}');
    const result = await toolset.handle(tc);

    expect(result.toolCallId).toBe('1');
    expect(result.returnValue.isError).toBe(true);
    expect(result.returnValue.message).toBe('Error running tool: boom');
    expect(result.returnValue.display).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'brief', text: 'Tool runtime error' }),
      ]),
    );
  });

  it('handle() resolves to toolRuntimeError when the handler throws synchronously', async () => {
    const toolset = new SimpleToolset();
    toolset.add(
      { name: 'explode_sync', description: 'Throws synchronously', parameters: {} },
      (): Promise<ToolReturnValue> => {
        throw new Error('boom');
      },
    );

    await expect(toolset.handle(makeToolCall('1', 'explode_sync', '{}'))).resolves.toMatchObject({
      toolCallId: '1',
      returnValue: expect.objectContaining({
        isError: true,
        message: expect.stringContaining('boom'),
      }),
    });
  });

  it('handle() resolves to toolRuntimeError when the handler returns Promise.reject()', async () => {
    const toolset = new SimpleToolset();
    toolset.add(
      { name: 'explode_reject', description: 'Rejects', parameters: {} },
      async (): Promise<ToolReturnValue> => {
        throw new Error('boom reject');
      },
    );

    await expect(toolset.handle(makeToolCall('1', 'explode_reject', '{}'))).resolves.toMatchObject({
      toolCallId: '1',
      returnValue: expect.objectContaining({
        isError: true,
        message: expect.stringContaining('boom reject'),
      }),
    });
  });

  it('handle() returns toolValidateError when arguments do not satisfy parameters schema', async () => {
    const toolset = new SimpleToolset();
    let handlerCalled = false;
    toolset.add(
      {
        name: 'needs_x',
        description: 'Requires x',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'string' },
          },
          required: ['x'],
        },
      },
      async (): Promise<ToolReturnValue> => {
        handlerCalled = true;
        return toolOk({ output: 'ok' });
      },
    );

    const result = await toolset.handle(makeToolCall('1', 'needs_x', '{}'));

    expect(result.toolCallId).toBe('1');
    expect(result.returnValue.isError).toBe(true);
    expect(result.returnValue.message).toContain('Error validating JSON arguments:');
    expect(result.returnValue.message).toContain('x');
    expect(result.returnValue.display).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'brief', text: 'Invalid arguments' }),
      ]),
    );
    expect(handlerCalled).toBe(false);
  });

  it('add() and remove() manage tools', () => {
    const toolset = new SimpleToolset();

    expect(toolset.tools).toHaveLength(0);

    toolset.add(
      { name: 'a', description: 'tool a', parameters: {} },
      async (): Promise<ToolReturnValue> => toolOk({ output: '' }),
    );
    toolset.add(
      { name: 'b', description: 'tool b', parameters: {} },
      async (): Promise<ToolReturnValue> => toolOk({ output: '' }),
    );

    expect(toolset.tools).toHaveLength(2);
    expect(toolset.tools.map((t) => t.name)).toEqual(['a', 'b']);

    toolset.remove('a');
    expect(toolset.tools).toHaveLength(1);
    expect(toolset.tools[0]!.name).toBe('b');
  });

  it('add() overwrites existing tool with same name', async () => {
    const toolset = new SimpleToolset();

    toolset.add(
      { name: 'tool', description: 'v1', parameters: {} },
      async (): Promise<ToolReturnValue> => toolOk({ output: 'v1' }),
    );
    toolset.add(
      { name: 'tool', description: 'v2', parameters: {} },
      async (): Promise<ToolReturnValue> => toolOk({ output: 'v2' }),
    );

    expect(toolset.tools).toHaveLength(1);
    expect(toolset.tools[0]!.description).toBe('v2');

    const tc = makeToolCall('1', 'tool', '{}');
    const result = await toolset.handle(tc);
    expect(result.returnValue.output).toBe('v2');
  });

  it('handle() uses empty object when arguments is null', async () => {
    const toolset = new SimpleToolset();
    let receivedArgs: JsonType = null;
    toolset.add(
      { name: 'tool', description: 'test', parameters: {} },
      async (args: JsonType): Promise<ToolReturnValue> => {
        receivedArgs = args;
        return toolOk({ output: 'ok' });
      },
    );

    const tc = makeToolCall('1', 'tool', null);
    await toolset.handle(tc);

    expect(receivedArgs).toEqual({});
  });

  it('remove() throws for non-existent tool', () => {
    const toolset = new SimpleToolset();
    expect(() => toolset.remove('does-not-exist')).toThrow(
      'Tool `does-not-exist` not found in the toolset.',
    );
  });
});
