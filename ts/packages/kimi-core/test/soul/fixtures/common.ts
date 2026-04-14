/**
 * Test helper — factories for the smallest valid `ChatResponse` shapes
 * used across Slice 2 tests, plus a convenience `buildContext()` that
 * wraps the Slice 1 `InMemoryContextState` with sensible defaults so
 * each test file stays focused on its own scenario.
 */

import type {
  AssistantMessage,
  ChatResponse,
  StopReason,
  TokenUsage,
  ToolCall,
} from '../../../src/soul/index.js';
import type { AssistantMessagePayload } from '../../../src/storage/context-state.js';
import { InMemoryContextState } from '../../../src/storage/context-state.js';

export function makeAssistantText(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
  };
}

export function makeAssistantToolCalls(calls: ToolCall[]): AssistantMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: calls,
  };
}

export function makeEndTurnResponse(text: string, usage: Partial<TokenUsage> = {}): ChatResponse {
  return {
    message: { ...makeAssistantText(text), stop_reason: 'end_turn' },
    toolCalls: [],
    stopReason: 'end_turn',
    usage: zeroUsage(usage),
  };
}

export function makeToolUseResponse(
  toolCalls: ToolCall[],
  usage: Partial<TokenUsage> = {},
): ChatResponse {
  return {
    message: makeAssistantToolCalls(toolCalls),
    toolCalls,
    stopReason: 'tool_use',
    usage: zeroUsage(usage),
  };
}

export function makeResponse(
  message: AssistantMessage,
  toolCalls: ToolCall[],
  stopReason: StopReason,
  usage: Partial<TokenUsage> = {},
): ChatResponse {
  return {
    message,
    toolCalls,
    stopReason,
    usage: zeroUsage(usage),
  };
}

export function zeroUsage(partial: Partial<TokenUsage> = {}): TokenUsage {
  return {
    input: 0,
    output: 0,
    ...partial,
  };
}

export function makeToolCall(name: string, args: Record<string, unknown>, id?: string): ToolCall {
  return {
    id: id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
    name,
    args,
  };
}

export function buildContext(initialModel = 'test-model'): InMemoryContextState {
  return new InMemoryContextState({ initialModel });
}

// Re-export the Slice 1 assistant payload type so tests can assert that
// Soul correctly projects a v2 `AssistantMessage` down into the Slice 1
// storage shape — the exact adapter layer Soul owns internally.
export type { AssistantMessagePayload };
