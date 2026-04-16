/**
 * KosongAdapter — wraps a `ChatProvider` from `@moonshot-ai/kosong` so it
 * satisfies the Slice 2 `KosongAdapter` interface (v2 §5.8.2 / §11.1).
 *
 * Slice 2.1 rewrite: this adapter delegates to kosong's `generate()`
 * aggregator rather than driving `provider.generate()` directly. The
 * aggregator owns three things that the adapter previously half-implemented:
 *   - merging of `ToolCallPart` argument deltas into fully-assembled
 *     `ToolCall` objects (Phase 1 audit Slice 3 M4: parallel tool calls
 *     streamed as interleaved headers + delta chunks used to collapse to
 *     `{}` because `consumePart` ignored `tool_call_part`)
 *   - parallel-tool-call index routing so argument streams that interleave
 *     across calls (`tc0-header → tc1-header → tc0-args → tc1-args`) are
 *     demultiplexed correctly
 *   - empty / think-only response detection raised as
 *     `APIEmptyResponseError`
 *
 * Responsibilities that remain in the adapter:
 *   - Translate Soul-side `ChatParams` into kosong's `generate()` shape:
 *     `LLMToolDefinition[]` → kosong `Tool[]`, `ChatParams.effort` →
 *     `provider.withThinking()` (per Q2: only when defined), `onDelta` →
 *     `GenerateCallbacks.onMessagePart` for text parts.
 *   - Map the returned kosong `Message` into Soul's `AssistantMessage` +
 *     `ToolCall[]` shapes (note the name difference: kosong `ToolCall` is
 *     `{ function: { name, arguments: string|null } }` whereas Soul
 *     `ToolCall` is `{ name, args: unknown }`).
 *   - Map kosong `TokenUsage` (inputOther / output / inputCacheRead /
 *     inputCacheCreation) into Soul `TokenUsage` (input / output /
 *     cache_read / cache_write), where `input` is the combined total.
 *   - Map kosong `FinishReason` into Soul `StopReason`.
 *   - Report `provider.modelName` back to the caller via
 *     `ChatResponse.actualModel` so the transcript can record the model
 *     that was really used (Q1 / Q3).
 *
 * Coordinator decisions (Slice 2.1):
 *   - Q1: `ChatParams.model` is retained on the wire but ignored for
 *     provider selection. A mismatch between the requested model and
 *     `provider.modelName` is silently tolerated (no throw) — per-call
 *     model switch would require a provider factory above the adapter.
 *   - Q2: `ChatParams.effort === undefined` means "use the provider's
 *     default thinking state" — we must NOT call `withThinking()` in that
 *     case, or we would overwrite an effort configured at provider
 *     construction time.
 *   - Q3: The transcript model is the provider's `modelName` snapshot
 *     taken on the same provider instance that handled this call (i.e.
 *     after any per-call `withThinking()` copy, which preserves
 *     `modelName`).
 */

import { generate } from '@moonshot-ai/kosong';
import type {
  ChatProvider,
  StreamedMessagePart as KosongStreamedPart,
  Tool as KosongTool,
  FinishReason as KosongFinishReason,
  ThinkingEffort as KosongThinkingEffort,
  TokenUsage as KosongTokenUsage,
} from '@moonshot-ai/kosong';

import type {
  AssistantMessage,
  ChatParams,
  ChatResponse,
  ContentBlock,
  KosongAdapter as KosongAdapterInterface,
  StopReason,
  TokenUsage,
  ToolCall,
} from '../soul/index.js';

export interface KosongAdapterOptions {
  readonly provider: ChatProvider;
}

export class KosongAdapter implements KosongAdapterInterface {
  private readonly provider: ChatProvider;

  constructor(options: KosongAdapterOptions) {
    this.provider = options.provider;
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    // Pre-flight abort check so callers that abort before invoking the
    // adapter get an immediate rejection without touching the provider.
    // (kosong generate() also does its own pre-flight check, but surfacing
    // the rejection here keeps stack traces tidy for Soul-level callers.)
    params.signal.throwIfAborted();

    // Q2: only route effort through withThinking() when the caller
    // provided one. `undefined` means "use the provider's default" — which
    // was configured at provider construction time. Calling
    // withThinking(undefined) or withThinking('off') would overwrite that.
    //
    // `withThinking()` returns a shallow copy of the provider that shares
    // the underlying HTTP client, so per-call copies are cheap.
    const activeProvider: ChatProvider =
      params.effort !== undefined
        ? this.provider.withThinking(params.effort as KosongThinkingEffort)
        : this.provider;

    const kosongTools: KosongTool[] = params.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: isRecord(t.input_schema) ? t.input_schema : { type: 'object' },
    }));

    // Drive kosong's aggregator. Text and thinking deltas are forwarded to
    // the caller via `onDelta` / `onThinkDelta` through `onMessagePart`.
    // Tool call deltas are not exposed as streaming events — they arrive
    // aggregated in `result.message.toolCalls` below.
    const onDelta = params.onDelta;
    const onThinkDelta = params.onThinkDelta;
    const needMessagePart = onDelta !== undefined || onThinkDelta !== undefined;
    const result = await generate(
      activeProvider,
      params.systemPrompt,
      kosongTools,
      params.messages,
      needMessagePart
        ? {
            onMessagePart: (part: KosongStreamedPart): void => {
              if (part.type === 'text' && onDelta !== undefined) {
                onDelta(part.text);
              } else if (part.type === 'think' && onThinkDelta !== undefined) {
                onThinkDelta(part.think);
              }
            },
          }
        : undefined,
      { signal: params.signal },
    );

    // Map kosong Message content → Soul ContentBlock[]. Images / audio /
    // video are intentionally dropped at this layer, matching the pre-
    // Slice-2.1 behaviour (see Slice 4 for structured content persistence).
    const contentBlocks: ContentBlock[] = [];
    for (const part of result.message.content) {
      if (part.type === 'text') {
        contentBlocks.push({ type: 'text', text: part.text });
      } else if (part.type === 'think') {
        const block: ContentBlock = { type: 'thinking', thinking: part.think };
        if (part.encrypted !== undefined) {
          block.signature = part.encrypted;
        }
        contentBlocks.push(block);
      }
    }

    const toolCalls: ToolCall[] = result.message.toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      args: parseToolArgs(tc.function.arguments),
    }));

    const usage = mapUsage(result.usage);
    const stopReason = mapFinishReason(result.finishReason);

    const message: AssistantMessage = {
      role: 'assistant',
      content: contentBlocks,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(stopReason !== undefined ? { stop_reason: stopReason } : {}),
    };

    const response: ChatResponse = {
      message,
      toolCalls,
      usage,
      actualModel: activeProvider.modelName,
      ...(stopReason !== undefined ? { stopReason } : {}),
    };
    return response;
  }
}

export function createKosongAdapter(options: KosongAdapterOptions): KosongAdapter {
  return new KosongAdapter(options);
}

// ── helpers ────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseToolArgs(raw: string | null): unknown {
  if (raw === null || raw.length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function mapUsage(raw: KosongTokenUsage | null): TokenUsage {
  if (raw === null) {
    return { input: 0, output: 0 };
  }
  const input = raw.inputOther + raw.inputCacheRead + raw.inputCacheCreation;
  const usage: TokenUsage = { input, output: raw.output };
  if (raw.inputCacheRead > 0) {
    usage.cache_read = raw.inputCacheRead;
  }
  if (raw.inputCacheCreation > 0) {
    usage.cache_write = raw.inputCacheCreation;
  }
  return usage;
}

function mapFinishReason(reason: KosongFinishReason | null): StopReason | undefined {
  if (reason === null) return undefined;
  switch (reason) {
    case 'completed':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'truncated':
      return 'max_tokens';
    case 'filtered':
    case 'paused':
    case 'other':
      return 'unknown';
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}
