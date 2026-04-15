/**
 * KosongAdapter — wraps a `ChatProvider` from `@moonshot-ai/kosong` so it
 * satisfies the Slice 2 `KosongAdapter` interface (v2 §5.8.2 / §11.1).
 *
 * Responsibilities:
 *   - Translate Soul-side `ChatParams` (messages already in kosong `Message`
 *     shape, `LLMToolDefinition[]`, model, signal, onDelta) into kosong's
 *     `provider.generate(systemPrompt, tools, history, opts)` signature.
 *   - Consume the streamed response: collect text / thinking / tool-call
 *     parts into a v2 `AssistantMessage`, forward `text` chunks to the
 *     optional `onDelta` callback, and extract any completed tool calls.
 *   - Map kosong `TokenUsage` (inputOther / output / inputCacheRead /
 *     inputCacheCreation) into Soul `TokenUsage` (input / output /
 *     cache_read / cache_write), where `input` is the combined total.
 *   - Map kosong `FinishReason` into Soul `StopReason`.
 *   - Honour `params.signal` at both the pre-flight check and between
 *     streamed parts.
 */

import type {
  ChatProvider,
  GenerateOptions as KosongGenerateOptions,
  StreamedMessagePart as KosongStreamedPart,
  Tool as KosongTool,
  FinishReason as KosongFinishReason,
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
    params.signal.throwIfAborted();

    const kosongTools: KosongTool[] = params.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: isRecord(t.input_schema) ? t.input_schema : { type: 'object' },
    }));

    const generateOpts: KosongGenerateOptions = { signal: params.signal };
    const streamed = await this.provider.generate('', kosongTools, params.messages, generateOpts);

    const contentBlocks: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];

    for await (const part of streamed) {
      if (params.signal.aborted) {
        params.signal.throwIfAborted();
      }
      consumePart(part, contentBlocks, toolCalls, params.onDelta, params.onThinkDelta);
    }

    const usage = mapUsage(streamed.usage);
    const stopReason = mapFinishReason(streamed.finishReason);

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

function consumePart(
  part: KosongStreamedPart,
  contentBlocks: ContentBlock[],
  toolCalls: ToolCall[],
  onDelta: ((delta: string) => void) | undefined,
  onThinkDelta: ((delta: string) => void) | undefined,
): void {
  switch (part.type) {
    case 'text': {
      contentBlocks.push({ type: 'text', text: part.text });
      onDelta?.(part.text);
      return;
    }
    case 'think': {
      const block: ContentBlock = { type: 'thinking', thinking: part.think };
      if (part.encrypted !== undefined) {
        block.signature = part.encrypted;
      }
      contentBlocks.push(block);
      onThinkDelta?.(part.think);
      return;
    }
    case 'function': {
      toolCalls.push({
        id: part.id,
        name: part.function.name,
        args: parseToolArgs(part.function.arguments),
      });
      return;
    }
    case 'tool_call_part': {
      // Streaming tool_call_part carries incremental argument chunks.
      const argsPart = (part as { argumentsPart?: string }).argumentsPart;
      if (argsPart && toolCalls.length > 0) {
        const last = toolCalls[toolCalls.length - 1]!;
        if ((last as { _rawArgs?: string })._rawArgs === undefined) {
          (last as { _rawArgs?: string })._rawArgs = '';
        }
        (last as { _rawArgs: string })._rawArgs += argsPart;
        try {
          last.args = JSON.parse((last as { _rawArgs: string })._rawArgs);
        } catch {
          // Incomplete JSON — will be complete on a later chunk.
        }
      }
      return;
    }
    case 'audio_url':
    case 'image_url':
    case 'video_url': {
      // Slice 3 does not surface multimodal parts to Soul.
      return;
    }
    default: {
      const _exhaustive: never = part;
      void _exhaustive;
    }
  }
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
