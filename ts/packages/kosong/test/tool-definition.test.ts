import { describe, expect, test } from 'vitest';

import { ToolDefinitionError } from '../src/tool-errors.js';
import { validateToolSchema } from '../src/tool.js';
import type { Tool } from '../src/tool.js';

describe('validateToolSchema', () => {
  test('accepts a valid JSON schema', () => {
    const tool: Tool = {
      name: 'echo',
      description: 'Echo text',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    };

    expect(() => validateToolSchema(tool)).not.toThrow();
  });

  test('throws ToolDefinitionError for an invalid JSON schema', () => {
    const tool: Tool = {
      name: 'broken_tool',
      description: 'Broken schema',
      parameters: {
        type: 123,
      },
    };

    expect(() => validateToolSchema(tool)).toThrowError(ToolDefinitionError);
    expect(() => validateToolSchema(tool)).toThrowError(
      /^Invalid parameters schema for tool 'broken_tool': /,
    );
  });
});
