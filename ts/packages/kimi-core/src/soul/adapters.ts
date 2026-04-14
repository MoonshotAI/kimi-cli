/**
 * Soul-internal shape adapters between the v2 Soul types (§5.1 / §附录 D)
 * and the Slice 1 storage payload shapes (`src/storage/context-state.ts`).
 *
 * These adapters are **not** exported from `src/soul/index.ts` — they are
 * implementation details of `runSoulTurn` and live in a sibling module so
 * `run-turn.ts` can stay focused on the main agent loop.
 *
 * Import whitelist discipline (§5.0 rule 3): this file only imports from
 * `zod`, Slice 1 storage types (type-only), and sibling Soul modules.
 */

import { z } from 'zod';

import type { AssistantMessagePayload, ToolResultPayload } from '../storage/context-state.js';
import type { ChatResponse, LLMToolDefinition } from './runtime.js';
import type { ContentBlock, Tool, ToolResult } from './types.js';

/**
 * Widen `ToolCall.args` (`unknown`) into the `Record<string, unknown>` shape
 * `SoulEvent.tool.call` carries. Non-object args (number / string / null)
 * fall back to an empty record — a known v2 vs event-shape impedance noted
 * in PHASE1_PROGRESS.md §8 row 9.
 */
export function toToolCallArgs(args: unknown): Record<string, unknown> {
  if (args !== null && typeof args === 'object') {
    return args as Record<string, unknown>;
  }
  return {};
}

/**
 * Zod → JSON Schema conversion for `LLMToolDefinition.input_schema`.
 *
 * Slice 2 uses `z.toJSONSchema` with a `{type:'object'}` fallback. Slice 3
 * (§附录 D.6 / `KosongAdapter`) is expected to upgrade this to a real
 * provider-neutral conversion.
 */
export function zodToSchema(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema);
  } catch {
    return { type: 'object' };
  }
}

export function buildLLMVisibleTools(
  tools: readonly Tool[],
  activeTools?: readonly string[],
): LLMToolDefinition[] {
  const visible =
    activeTools === undefined ? tools : tools.filter((t) => activeTools.includes(t.name));
  return visible.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: zodToSchema(t.inputSchema),
  }));
}

/**
 * kosong `ChatResponse` → Slice 1 `AssistantMessagePayload`.
 *
 * The two shapes disagree in three places (see PHASE1_PROGRESS.md §5.1
 * notes):
 *   1. v2 `message.content` is `string | ContentBlock[]`; Slice 1 is flat
 *      `{text: string|null, think: string|null}`
 *   2. `ContentBlock.thinking` (v2 type field) → `think` (Slice 1 field)
 *   3. `TokenUsage` (camelCase) → storage usage (snake_case)
 *
 * No fields are dropped — the `stop_reason` on the v2 `AssistantMessage`
 * is carried separately on `ChatResponse.stopReason` and consumed by the
 * main loop to decide whether to break, so it doesn't need to enter the
 * storage payload.
 */
export function adaptAssistantMessage(chat: ChatResponse, model: string): AssistantMessagePayload {
  const c = chat.message.content;
  const blocks: ContentBlock[] =
    typeof c === 'string' ? (c.length > 0 ? [{ type: 'text', text: c }] : []) : c;
  const textParts = blocks.filter(
    (b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text',
  );
  const thinkParts = blocks.filter(
    (b): b is Extract<ContentBlock, { type: 'thinking' }> => b.type === 'thinking',
  );
  const text = textParts.length > 0 ? textParts.map((b) => b.text).join('') : null;
  const think = thinkParts.length > 0 ? thinkParts.map((b) => b.thinking).join('') : null;
  const payload: AssistantMessagePayload = {
    text,
    think,
    toolCalls: chat.toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      args: tc.args,
    })),
    model,
  };
  if (chat.usage !== undefined) {
    const u: AssistantMessagePayload['usage'] = {
      input_tokens: chat.usage.input,
      output_tokens: chat.usage.output,
    };
    if (chat.usage.cache_read !== undefined) {
      (u as { cache_read_tokens?: number }).cache_read_tokens = chat.usage.cache_read;
    }
    payload.usage = u;
  }
  return payload;
}

/**
 * v2 `ToolResult` → Slice 1 `ToolResultPayload`.
 *
 * `ToolResult.content` is `string | ToolResultContent[]`; Slice 1 stores a
 * single `output: unknown` — for content-block arrays we concatenate the
 * text blocks and placeholder image blocks. Slice 4 (Tool system) may
 * revisit this if the projector needs richer tool_result rendering.
 */
export function adaptToolResult(r: ToolResult): ToolResultPayload {
  const output =
    typeof r.content === 'string'
      ? r.content
      : r.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('');
  const payload: ToolResultPayload = { output };
  if (r.isError === true) payload.isError = true;
  return payload;
}
