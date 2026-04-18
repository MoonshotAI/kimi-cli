import OpenAI from 'openai';

import { UNKNOWN_CAPABILITY, type ModelCapability } from '../capability.js';
import { ChatProviderError } from '../errors.js';
import type { ContentPart, Message, StreamedMessagePart, ToolCall } from '../message.js';
import type {
  FinishReason,
  GenerateOptions,
  RetryableChatProvider,
  StreamedMessage,
  ThinkingEffort,
} from '../provider.js';
import type { Tool } from '../tool.js';
import type { TokenUsage } from '../usage.js';
import { KimiFiles } from './kimi-files.js';
import {
  convertContentPart,
  convertOpenAIError,
  extractUsage,
  isFunctionToolCall,
  normalizeOpenAIFinishReason,
  type OpenAIContentPart,
  type OpenAIToolParam,
  reasoningEffortToThinkingEffort,
  toolToOpenAI,
} from './openai-common.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface KimiOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  stream?: boolean | undefined;
  defaultHeaders?: Record<string, string> | undefined;
}

export interface GenerationKwargs {
  max_tokens?: number | undefined;
  temperature?: number | undefined;
  top_p?: number | undefined;
  n?: number | undefined;
  presence_penalty?: number | undefined;
  frequency_penalty?: number | undefined;
  stop?: string | string[] | undefined;
  prompt_cache_key?: string | undefined;
  reasoning_effort?: string | undefined;
  extra_body?: Record<string, unknown> | undefined;
}

interface ThinkingConfig {
  type: 'enabled' | 'disabled';
}

// ── Message conversion ────────────────────────────────────────────────

interface OpenAIMessage {
  role: string;
  content?: string | OpenAIContentPart[] | undefined;
  tool_calls?: OpenAIToolCallOut[] | undefined;
  tool_call_id?: string | undefined;
  name?: string | undefined;
  reasoning_content?: string | undefined;
}

interface OpenAIToolCallOut {
  type: string;
  id: string;
  function: { name: string; arguments: string | null };
  extras?: Record<string, unknown> | undefined;
}

interface StreamToolFunctionDelta {
  name?: string | undefined;
  arguments?: string | undefined;
}

interface StreamToolCallDelta {
  index?: number | string | undefined;
  id?: string | undefined;
  function?: StreamToolFunctionDelta | undefined;
}

interface BufferedStreamToolCall {
  id?: string | undefined;
  arguments: string;
  emitted: boolean;
}

function convertStreamToolCall(
  toolCall: StreamToolCallDelta,
  bufferedByIndex: Map<number | string, BufferedStreamToolCall>,
): StreamedMessagePart[] {
  if (!toolCall.function) {
    return [];
  }

  const streamIndex = toolCall.index;
  const functionName = toolCall.function.name;
  const functionArguments = toolCall.function.arguments;
  const hasConcreteName = typeof functionName === 'string' && functionName.length > 0;
  const hasArguments = typeof functionArguments === 'string' && functionArguments.length > 0;

  if (streamIndex === undefined) {
    if (hasConcreteName) {
      return [
        {
          type: 'function',
          id: toolCall.id ?? crypto.randomUUID(),
          function: {
            name: functionName,
            arguments: functionArguments ?? null,
          },
        } satisfies ToolCall,
      ];
    }

    if (hasArguments) {
      return [
        { type: 'tool_call_part', argumentsPart: functionArguments } satisfies StreamedMessagePart,
      ];
    }

    return [];
  }

  const buffered = bufferedByIndex.get(streamIndex) ?? { arguments: '', emitted: false };
  if (toolCall.id !== undefined) {
    buffered.id = toolCall.id;
  }

  if (!buffered.emitted) {
    if (!hasConcreteName) {
      if (hasArguments) {
        buffered.arguments += functionArguments;
      }
      bufferedByIndex.set(streamIndex, buffered);
      return [];
    }

    buffered.emitted = true;
    const initialArguments =
      buffered.arguments.length > 0
        ? buffered.arguments + (functionArguments ?? '')
        : (functionArguments ?? null);
    buffered.arguments = '';
    bufferedByIndex.set(streamIndex, buffered);

    const toolCallHeader: ToolCall = {
      type: 'function',
      id: buffered.id ?? toolCall.id ?? crypto.randomUUID(),
      function: {
        name: functionName,
        arguments: initialArguments,
      },
      _streamIndex: streamIndex,
    };
    return [toolCallHeader];
  }

  if (!hasArguments) {
    return [];
  }

  const part: StreamedMessagePart & { index: number | string } = {
    type: 'tool_call_part',
    argumentsPart: functionArguments,
    index: streamIndex,
  };
  return [part];
}

function convertMessage(message: Message): OpenAIMessage {
  let reasoningContent = '';
  const nonThinkParts: ContentPart[] = [];

  for (const part of message.content) {
    if (part.type === 'think') {
      reasoningContent += part.think;
    } else {
      nonThinkParts.push(part);
    }
  }

  // Build the OpenAI message.
  const result: OpenAIMessage = { role: message.role };

  // content: serialize to string if single text, array otherwise
  const firstPart = nonThinkParts[0];
  if (nonThinkParts.length === 1 && firstPart?.type === 'text') {
    result.content = firstPart.text;
  } else if (nonThinkParts.length > 0) {
    result.content = nonThinkParts
      .map((p) => convertContentPart(p))
      .filter((p): p is OpenAIContentPart => p !== null);
  }

  if (message.name !== undefined) {
    result.name = message.name;
  }

  if (message.toolCalls.length > 0) {
    result.tool_calls = message.toolCalls.map((tc) => {
      const mapped: OpenAIToolCallOut = {
        type: tc.type,
        id: tc.id,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      };
      if (tc.extras !== undefined) {
        mapped.extras = tc.extras;
      }
      return mapped;
    });
  }

  if (message.toolCallId !== undefined) {
    result.tool_call_id = message.toolCallId;
  }

  if (reasoningContent) {
    result.reasoning_content = reasoningContent;
  }

  return result;
}

// ── Tool conversion ───────────────────────────────────────────────────

function convertTool(tool: Tool): OpenAIToolParam {
  if (tool.name.startsWith('$')) {
    // Kimi builtin functions start with `$`
    return {
      type: 'builtin_function',
      function: { name: tool.name },
    };
  }
  return toolToOpenAI(tool);
}

// ── KimiStreamedMessage ───────────────────────────────────────────────

/**
 * Extract usage from a streaming chunk. Moonshot may place usage in
 * `choices[0].usage` in addition to the top-level `usage` field.
 */
export function extractUsageFromChunk(
  chunk: Record<string, unknown>,
): Record<string, unknown> | null {
  // Top-level usage
  if (
    chunk['usage'] !== null &&
    chunk['usage'] !== undefined &&
    typeof chunk['usage'] === 'object'
  ) {
    return chunk['usage'] as Record<string, unknown>;
  }
  // choices[0].usage (Moonshot proprietary)
  const choices = chunk['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const firstChoice = choices[0] as Record<string, unknown> | undefined;
  if (firstChoice === undefined) {
    return null;
  }
  const choiceUsage = firstChoice['usage'];
  if (choiceUsage !== null && choiceUsage !== undefined && typeof choiceUsage === 'object') {
    return choiceUsage as Record<string, unknown>;
  }
  return null;
}

class KimiStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(
    response: OpenAI.Chat.ChatCompletion | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    isStream: boolean,
  ) {
    if (isStream) {
      this._iter = this._convertStreamResponse(
        response as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
      );
    } else {
      this._iter = this._convertNonStreamResponse(response as OpenAI.Chat.ChatCompletion);
    }
  }

  get id(): string | null {
    return this._id;
  }

  get usage(): TokenUsage | null {
    return this._usage;
  }

  get finishReason(): FinishReason | null {
    return this._finishReason;
  }

  get rawFinishReason(): string | null {
    return this._rawFinishReason;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    yield* this._iter;
  }

  private _captureFinishReason(raw: string | null | undefined): void {
    const normalized = normalizeOpenAIFinishReason(raw);
    this._finishReason = normalized.finishReason;
    this._rawFinishReason = normalized.rawFinishReason;
  }

  private async *_convertNonStreamResponse(
    response: OpenAI.Chat.ChatCompletion,
  ): AsyncGenerator<StreamedMessagePart> {
    this._id = response.id;
    if (response.usage) {
      this._usage = extractUsage(response.usage) ?? null;
    }
    this._captureFinishReason(response.choices[0]?.finish_reason ?? null);

    const message = response.choices[0]?.message;
    if (!message) return;

    // reasoning_content (Moonshot proprietary)
    const rc = (message as unknown as Record<string, unknown>)['reasoning_content'];
    if (typeof rc === 'string' && rc) {
      yield { type: 'think', think: rc } satisfies StreamedMessagePart;
    }

    if (message.content) {
      yield { type: 'text', text: message.content } satisfies StreamedMessagePart;
    }

    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        if (!isFunctionToolCall(toolCall)) continue;
        yield {
          type: 'function',
          id: toolCall.id || crypto.randomUUID(),
          function: {
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          },
        } satisfies ToolCall;
      }
    }
  }

  private async *_convertStreamResponse(
    response: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  ): AsyncGenerator<StreamedMessagePart> {
    const bufferedToolCalls = new Map<number | string, BufferedStreamToolCall>();

    try {
      for await (const chunk of response) {
        if (chunk.id) {
          this._id = chunk.id;
        }

        // Extract usage from chunk (supports top-level and choices[0].usage)
        const rawChunk = chunk as unknown as Record<string, unknown>;
        const rawUsage = extractUsageFromChunk(rawChunk);
        if (rawUsage) {
          this._usage = extractUsage(rawUsage) ?? null;
        }

        if (!chunk.choices || chunk.choices.length === 0) {
          continue;
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        // Capture finish_reason whenever the chunk carries one. The Chat
        // Completions API only sets it on the final chunk for a given
        // choice, but defensively re-capturing on every non-null value
        // keeps the latest signal available even if upstream re-emits.
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          this._captureFinishReason(choice.finish_reason);
        }

        const delta = choice.delta;

        // reasoning_content (Moonshot proprietary)
        const rc = (delta as unknown as Record<string, unknown>)['reasoning_content'];
        if (typeof rc === 'string' && rc) {
          yield { type: 'think', think: rc } satisfies StreamedMessagePart;
        }

        // text content
        if (delta.content) {
          yield { type: 'text', text: delta.content } satisfies StreamedMessagePart;
        }

        // tool calls — preserve `index` on every yielded part so the generate
        // loop can route interleaved argument deltas from parallel tool calls.
        for (const toolCall of delta.tool_calls ?? []) {
          for (const part of convertStreamToolCall(toolCall, bufferedToolCalls)) {
            yield part;
          }
        }
      }
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    }
  }
}

// ── Kimi ChatProvider ─────────────────────────────────────────────────

export class KimiChatProvider implements RetryableChatProvider {
  readonly name: string = 'kimi';

  private _model: string;
  private _stream: boolean;
  private _apiKey: string;
  private _baseUrl: string;
  private _generationKwargs: GenerationKwargs;
  private _client: OpenAI;
  private _files: KimiFiles | undefined;

  constructor(options: KimiOptions) {
    const apiKey = options.apiKey ?? process.env['KIMI_API_KEY'];
    if (!apiKey) {
      throw new ChatProviderError(
        'KimiChatProvider: apiKey is required. Set KimiOptions.apiKey or the KIMI_API_KEY environment variable.',
      );
    }
    this._apiKey = apiKey;
    this._baseUrl = options.baseUrl ?? process.env['KIMI_BASE_URL'] ?? 'https://api.moonshot.ai/v1';
    this._model = options.model;
    this._stream = options.stream ?? true;
    this._generationKwargs = {};
    this._client = new OpenAI({
      apiKey: this._apiKey,
      baseURL: this._baseUrl,
      defaultHeaders: options.defaultHeaders,
    });
  }

  get modelName(): string {
    return this._model;
  }

  /**
   * File upload client for Kimi/Moonshot.
   *
   * Use this to upload videos (and other media in the future) to the file
   * service and receive a content part that can be embedded in chat
   * messages.
   */
  get files(): KimiFiles {
    this._files ??= new KimiFiles(this._client);
    return this._files;
  }

  get thinkingEffort(): ThinkingEffort | null {
    return reasoningEffortToThinkingEffort(this._generationKwargs.reasoning_effort);
  }

  get modelParameters(): Record<string, unknown> {
    return {
      model: this._model,
      baseUrl: this._baseUrl,
      ...this._generationKwargs,
    };
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    const messages: OpenAIMessage[] = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    for (const msg of history) {
      messages.push(convertMessage(msg));
    }

    const kwargs: Record<string, unknown> = {
      max_tokens: 32000,
      ...this._generationKwargs,
    };

    // Remove undefined values from kwargs
    for (const key of Object.keys(kwargs)) {
      if (kwargs[key] === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete kwargs[key];
      }
    }

    // Build the create params
    const createParams: Record<string, unknown> = {
      model: this._model,
      messages,
      stream: this._stream,
      ...kwargs,
    };

    if (tools.length > 0) {
      createParams['tools'] = tools.map((t) => convertTool(t));
    }

    if (this._stream) {
      createParams['stream_options'] = { include_usage: true };
    }

    try {
      // Use type assertion via unknown because we pass Moonshot-proprietary fields
      // (reasoning_effort, extra_body) that don't exist in the OpenAI type definitions.
      const response = (await this._client.chat.completions.create(
        createParams as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        options?.signal ? { signal: options.signal } : undefined,
      )) as unknown as OpenAI.Chat.ChatCompletion | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
      return new KimiStreamedMessage(response, this._stream);
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    }
  }

  onRetryableError(_error: Error): boolean {
    // Replace client to get a fresh connection.
    // OpenAI TS SDK v6 uses Node.js built-in fetch with no persistent connection pool,
    // so no explicit close() is needed. If a future SDK version exposes close(), call it here.
    this._client = new OpenAI({
      apiKey: this._apiKey,
      baseURL: this._baseUrl,
    });
    // Invalidate the cached KimiFiles so it picks up the new client on next access.
    this._files = undefined;
    return true;
  }

  getCapability(model?: string): ModelCapability {
    const name = (model ?? this._model).toLowerCase();
    // Kimi-for-coding / kimi-code: full multimodal + thinking + tools.
    if (name === 'kimi-for-coding' || name === 'kimi-code') {
      return {
        image_in: true,
        video_in: true,
        audio_in: false,
        thinking: true,
        tool_use: true,
        max_context_tokens: 256_000,
      };
    }
    // kimi-k2 family (k2, k2.5, k2-turbo-preview, …): image+video+thinking+tools.
    if (name.startsWith('kimi-k2')) {
      return {
        image_in: true,
        video_in: true,
        audio_in: false,
        thinking: true,
        tool_use: true,
        max_context_tokens: 256_000,
      };
    }
    // Name-substring heuristic: "thinking" or "reason" → thinking-capable.
    // Matches Python `derive_model_capabilities` fallback. We leave
    // other fields false (and return a partial capability rather than
    // UNKNOWN_CAPABILITY) because the only signal we have is that the
    // model does chain-of-thought. `tool_use: false` here is a
    // conservative assumption — most Kimi thinking models actually
    // support tools; if/when Slice B's gate extends to tool_use we
    // should replace this heuristic with a proper catalogue.
    if (name.includes('thinking') || name.includes('reason')) {
      return {
        image_in: false,
        video_in: false,
        audio_in: false,
        thinking: true,
        tool_use: false,
        max_context_tokens: 0,
      };
    }
    return UNKNOWN_CAPABILITY;
  }

  withThinking(effort: ThinkingEffort): KimiChatProvider {
    const thinking: ThinkingConfig = {
      type: effort === 'off' ? 'disabled' : 'enabled',
    };
    let reasoningEffort: string | undefined;
    switch (effort) {
      case 'off':
        reasoningEffort = undefined;
        break;
      case 'low':
        reasoningEffort = 'low';
        break;
      case 'medium':
        reasoningEffort = 'medium';
        break;
      case 'high':
        reasoningEffort = 'high';
        break;
    }
    return this._withGenerationKwargs({
      reasoning_effort: reasoningEffort,
      extra_body: {
        ...this._generationKwargs.extra_body,
        thinking,
      },
    });
  }

  withGenerationKwargs(kwargs: GenerationKwargs): KimiChatProvider {
    return this._withGenerationKwargs(kwargs);
  }

  private _withGenerationKwargs(kwargs: GenerationKwargs): KimiChatProvider {
    const clone = this._clone();
    clone._generationKwargs = { ...clone._generationKwargs, ...kwargs };
    return clone;
  }

  private _clone(): KimiChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as KimiChatProvider,
      this,
    );
    clone._generationKwargs = { ...this._generationKwargs };
    // Do not share the memoized KimiFiles instance with the clone; let it be
    // lazily re-created on first access.
    clone._files = undefined;
    return clone;
  }
}
