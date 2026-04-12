import { describe, expect, it } from 'vitest';

import { EmptyToolset } from '../src/empty-toolset.js';
import type { ToolCall } from '../src/message.js';

describe('EmptyToolset', () => {
  it('has no tools', () => {
    const toolset = new EmptyToolset();
    expect(toolset.tools).toEqual([]);
  });

  it('handle() always returns toolNotFoundError', () => {
    const toolset = new EmptyToolset();
    const tc: ToolCall = {
      type: 'function',
      id: 'call-1',
      function: { name: 'anything', arguments: '{}' },
    };

    const result = toolset.handle(tc);

    expect(result.toolCallId).toBe('call-1');
    expect(result.returnValue.isError).toBe(true);
    expect(result.returnValue.message).toContain('anything');
  });

  it('handle() includes tool name in error message', () => {
    const toolset = new EmptyToolset();
    const tc: ToolCall = {
      type: 'function',
      id: 'call-2',
      function: { name: 'read_file', arguments: null },
    };

    const result = toolset.handle(tc);

    expect(result.returnValue.message).toContain('read_file');
    expect(result.returnValue.display).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'brief', text: expect.stringContaining('read_file') }),
      ]),
    );
  });
});
