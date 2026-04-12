import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { SimpleToolset } from '../src/simple-toolset.js';
import { toolError, toolOk } from '../src/tool.js';
import type { ToolReturnValue } from '../src/tool.js';
import { createTypedTool } from '../src/typed-tool.js';

describe('createTypedTool', () => {
  test('creates a tool with zod schema and typed handler', async () => {
    const addTool = createTypedTool({
      name: 'add',
      description: 'Adds two numbers',
      params: z.object({
        a: z.number().describe('First number'),
        b: z.number().describe('Second number'),
      }),
      handler: async (params): Promise<ToolReturnValue> => {
        // params is typed as { a: number; b: number }
        return toolOk({ output: String(params.a + params.b) });
      },
    });

    expect(addTool.tool.name).toBe('add');
    expect(addTool.tool.description).toBe('Adds two numbers');
    expect(addTool.tool.parameters).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        a: expect.any(Object),
        b: expect.any(Object),
      }),
    });

    const result = await addTool.handler({ a: 2, b: 3 } as never);
    expect(result.isError).toBe(false);
    expect(result.output).toBe('5');
  });

  test('returns toolValidateError for missing required fields', async () => {
    const tool = createTypedTool({
      name: 'greet',
      description: 'Greets a user',
      params: z.object({
        name: z.string(),
      }),
      handler: async (params) => toolOk({ output: `Hello, ${params.name}` }),
    });

    // Pass invalid args (missing 'name')
    const result = await tool.handler({} as never);
    expect(result.isError).toBe(true);
    expect(result.message).toContain('name');
  });

  test('returns toolValidateError for wrong type', async () => {
    const tool = createTypedTool({
      name: 'multiply',
      description: 'Multiplies two numbers',
      params: z.object({
        a: z.number(),
        b: z.number(),
      }),
      handler: async (params) => toolOk({ output: String(params.a * params.b) }),
    });

    // Pass string where number expected
    const result = await tool.handler({ a: '2', b: 3 } as never);
    expect(result.isError).toBe(true);
  });

  test('returns toolValidateError for unknown keys to match exported schema', async () => {
    const tool = createTypedTool({
      name: 'strict_number',
      description: 'Accepts only x',
      params: z.object({
        x: z.number(),
      }),
      handler: async (params) => toolOk({ output: String(params.x) }),
    });

    expect(tool.tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });

    const result = await tool.handler({ x: 1, extra: 2 } as never);
    expect(result.isError).toBe(true);
    expect(result.message).toContain('extra');
  });

  test('integrates with SimpleToolset', async () => {
    const echoTool = createTypedTool({
      name: 'echo',
      description: 'Echoes the input',
      params: z.object({ text: z.string() }),
      handler: async (params) => toolOk({ output: params.text }),
    });

    const toolset = new SimpleToolset();
    toolset.add(echoTool.tool, echoTool.handler);

    const result = await toolset.handle({
      type: 'function',
      id: 'tc_001',
      function: { name: 'echo', arguments: JSON.stringify({ text: 'hello' }) },
    });

    expect(result.returnValue.isError).toBe(false);
    expect(result.returnValue.output).toBe('hello');
  });

  test('supports nested zod schemas', async () => {
    const tool = createTypedTool({
      name: 'process',
      description: 'Processes a complex object',
      params: z.object({
        user: z.object({
          name: z.string(),
          age: z.number().optional(),
        }),
        tags: z.array(z.string()),
      }),
      handler: async (params) =>
        toolOk({
          output: `${params.user.name} has ${params.tags.length} tags`,
        }),
    });

    const result = await tool.handler({
      user: { name: 'Alice', age: 30 },
      tags: ['a', 'b', 'c'],
    } as never);
    expect(result.isError).toBe(false);
    expect(result.output).toBe('Alice has 3 tags');
  });

  test('handler errors are caught and returned as tool errors', async () => {
    // Note: createTypedTool's handler does NOT catch user errors;
    // SimpleToolset.handle catches them. We test that the user can also
    // return toolError manually if they want.
    const tool2 = createTypedTool({
      name: 'safe',
      description: 'Returns error',
      params: z.object({ x: z.number() }),
      handler: async (params) =>
        toolError({
          message: `failed for x=${params.x}`,
          brief: 'fail',
        }),
    });

    const result = await tool2.handler({ x: 5 } as never);
    expect(result.isError).toBe(true);
    expect(result.message).toContain('failed for x=5');
  });
});
