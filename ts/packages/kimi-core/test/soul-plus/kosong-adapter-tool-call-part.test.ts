/**
 * Phase 17 B.6 — KosongAdapter.onToolCallPart surfaces tool_call_part
 * deltas.
 *
 * Soul's `onDelta` remains text-only `(string) => void`. Phase 17 §B.6
 * adds a dedicated `onToolCallPart` channel so providers that stream
 * tool_use args incrementally can push the structured shape without
 * breaking the legacy text callback. Fallback: providers that don't
 * chunk emit one consolidated part per finished tool_call.
 */

import { describe, expect, it } from 'vitest';

import { createScriptedKosong } from '../helpers/kosong/script-builder.js';
import type { ToolCallPartDelta } from '../../src/soul/runtime.js';

describe('Phase 17 B.6 — KosongAdapter onToolCallPart tool_call_part', () => {
  it('onToolCallPart receives tool_call_part deltas before final tool_use assistant message', async () => {
    const kosong = createScriptedKosong({
      turns: [
        {
          // Phase 17 B.6 — scripted tool_call_part chunks.
          toolCallParts: [
            { tool_call_id: 'tc_1', name: 'Bash', arguments_chunk: '{"com' },
            { tool_call_id: 'tc_1', arguments_chunk: 'mand":"ls"}' },
          ],
          stopReason: 'tool_use',
          toolCalls: [
            { id: 'tc_1', name: 'Bash', arguments: { command: 'ls' } },
          ],
        },
      ],
    });

    const partEvents: ToolCallPartDelta[] = [];
    const response = await kosong.chat({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'ls' }], toolCalls: [] },
      ],
      tools: [],
      model: 'test-model',
      systemPrompt: '',
      signal: new AbortController().signal,
      onToolCallPart: (part) => {
        partEvents.push(part);
      },
    });

    expect(partEvents.length).toBeGreaterThan(0);
    expect(partEvents[0]!.type).toBe('tool_call_part');
    expect(partEvents[0]!.tool_call_id).toBe('tc_1');

    // The final response still carries the complete tool_call.
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]!.name).toBe('Bash');
    expect(response.toolCalls[0]!.args).toEqual({ command: 'ls' });
  });
});
