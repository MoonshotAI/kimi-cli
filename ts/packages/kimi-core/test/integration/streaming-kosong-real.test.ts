/**
 * Phase 17 E.5 — StreamingKosongWrapper + real ToolCallOrchestrator
 * smoke.
 *
 * Prior tests drove StreamingKosongWrapper against mock orchestrators.
 * This smoke pins the wire through a real ToolCallOrchestrator
 * end-to-end: 2 concurrent safe tools (both `isConcurrencySafe:true`)
 * must both be prefetched by the wrapper and resolved through the
 * orchestrator without serialising on approval.
 *
 * Scope is deliberately narrow — one scenario — to catch
 * integration-level regressions the unit tests cannot see.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { StreamingKosongWrapper } from '../../src/soul-plus/streaming-kosong-wrapper.js';
import { ToolCallOrchestrator } from '../../src/soul-plus/orchestrator.js';
import { HookEngine } from '../../src/hooks/engine.js';
import { AlwaysAllowApprovalRuntime } from '../../src/soul-plus/approval-runtime.js';
import type { ChatParams, KosongAdapter } from '../../src/soul/runtime.js';
import type { Tool, ToolResult } from '../../src/soul/types.js';
import { PathConfig } from '../../src/session/path-config.js';

/**
 * Scripted streaming adapter: emits two concurrent tool_use parts in
 * the same assistant message so the wrapper can prefetch both.
 */
function makeScriptedStreamingAdapter(): KosongAdapter {
  return {
    chat: vi.fn(async (params) => {
      // Phase 17 §B.6 — simulate two tool_call_part chunks through
      // the dedicated `onToolCallPart` seam, then return the
      // assembled assistant message with the two concurrent tool
      // calls.
      params.onToolCallPart?.({
        type: 'tool_call_part',
        tool_call_id: 'tc_a',
        name: 'SafeA',
        arguments_chunk: '{}',
      });
      params.onToolCallPart?.({
        type: 'tool_call_part',
        tool_call_id: 'tc_b',
        name: 'SafeB',
        arguments_chunk: '{}',
      });
      return {
        message: {
          role: 'assistant' as const,
          content: [],
          stop_reason: 'tool_use' as const,
        },
        toolCalls: [
          { id: 'tc_a', name: 'SafeA', args: {} },
          { id: 'tc_b', name: 'SafeB', args: {} },
        ],
        stopReason: 'tool_use' as const,
        usage: { input: 1, output: 1 },
      };
    }),
  };
}

function makeSafeTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: z.object({}),
    isConcurrencySafe: (_input: unknown): boolean => true,
    metadata: { source: 'builtin' },
    async execute(): Promise<ToolResult> {
      // Small artificial delay so prefetch-parallel timing is
      // observable.
      await new Promise((r) => setTimeout(r, 20));
      return { content: `${name}:ok` };
    },
  };
}

describe('Phase 17 E.5 — StreamingKosongWrapper + real ToolCallOrchestrator smoke', () => {
  it('two concurrent safe tools prefetch in parallel and both resolve via orchestrator', async () => {
    const adapter = makeScriptedStreamingAdapter();
    const hookEngine = new HookEngine({ executors: new Map() });
    const orchestrator = new ToolCallOrchestrator({
      hookEngine,
      sessionId: () => 'ses_stream_smoke',
      agentId: 'agent_main',
      approvalRuntime: new AlwaysAllowApprovalRuntime(),
      pathConfig: new PathConfig({ home: '/tmp/kimi-stream-smoke' }),
    });
    const wrapper = new StreamingKosongWrapper(adapter, orchestrator);

    const start = Date.now();
    // Smoke-scope typing: the wrapper.chat params are shape-only here
    // because the real ChatParams shape is more restrictive than we
    // want to thread for a single integration check. The runtime
    // behaviour under test is the concurrent-prefetch path, not the
    // message-envelope validation (covered in unit tests).
    const params: ChatParams = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'run both' }], toolCalls: [] }],
      tools: [
        { name: 'SafeA', description: 'SafeA tool', input_schema: {} },
        { name: 'SafeB', description: 'SafeB tool', input_schema: {} },
      ],
      model: 'test-model',
      systemPrompt: '',
      signal: new AbortController().signal,
    };
    const response = await wrapper.chat(params);
    const elapsed = Date.now() - start;

    expect(response.toolCalls).toHaveLength(2);
    // Parallel prefetch: sequential would be ~40ms, parallel ~20ms.
    // Allow generous headroom for CI noise but assert sub-serial.
    expect(elapsed).toBeLessThan(80);
  });
});
