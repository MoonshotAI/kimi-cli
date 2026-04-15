/**
 * Covers: ThinkTool (Slice 3.5).
 *
 * Pins:
 *   - name is "Think" with a non-empty description
 *   - inputSchema accepts { thought: string }
 *   - execute always returns success with empty content (no-op)
 *   - getActivityDescription returns a fixed string
 */

import { describe, expect, it } from 'vitest';

import { ThinkTool } from '../../src/tools/think.js';

describe('ThinkTool', () => {
  const tool = new ThinkTool();

  it('has name "Think" and a non-empty description', () => {
    expect(tool.name).toBe('Think');
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('inputSchema accepts valid ThinkInput', () => {
    const result = tool.inputSchema.safeParse({ thought: 'Let me reason about this.' });
    expect(result.success).toBe(true);
  });

  it('inputSchema rejects missing thought', () => {
    const result = tool.inputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('execute returns success with empty content (no-op)', async () => {
    const result = await tool.execute(
      'call_1',
      { thought: 'This is intermediate reasoning.' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe('');
  });

  it('getActivityDescription returns a fixed string', () => {
    const desc = tool.getActivityDescription({ thought: 'anything' });
    expect(desc).toBe('Thinking…');
  });
});
