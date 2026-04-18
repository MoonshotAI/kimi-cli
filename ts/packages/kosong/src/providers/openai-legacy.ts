import OpenAI from 'openai';

import { UNKNOWN_CAPABILITY, type ModelCapability } from '../capability.js';
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
import {
  convertContentPart,
  convertOpenAIError,
  convertToolMessageContent,
  extractUsage,
  isFunctionToolCall,
  normalizeOpenAIFinishReason,
  type OpenAIContentPart,
  type ToolMessageConversion,
  reasoningEffortToThinkingEffort,
  thinkingEffortToReasoningEffort,
  toolToOpenAI,
} from './openai-common.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface OpenAILegacyOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  stream?: boolean | undefined;
  maxTokens?: number | undefined;
  reasoningKey?: string | undefined;
  httpClient?: unknown;
  toolMessageConversion?: ToolMessageConversion | undefined;
}

export interface OpenAILegacyGenerationKwargs {
  max_tokens?: number | undefined;
  temperature?: number | undefined;
  top_p?: number | undefined;
  n?: number | undefined;
  presence_penalty?: number | undefined;
  frequency_penalty?: number | undefined;
  stop?: string | string[] | undefined;
  [key: string]: unknown;
}

// ── Message conversion ────────────────────────────────────────────────

interface OpenAIMessage {
  role: string;
  content?: string | OpenAIContentPart[] | undefined;
  tool_calls?: OpenAIToolCallOut[] | undefined;
  tool_call_id?: string | undefined;
  name?: string | undefined;
  [key: string]: unknown;
}

interface OpenAIToolCallOut {
  type: string;
  id: string;
  function: { name: string; arguments: string | null };
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

function convertMessage(
  message: Message,
  reasoningKey: string | undefined,
  toolMessageConversion: ToolMessageConversion,
): OpenAIMessage {
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

  if (message.role === 'tool') {
    // OpenAI Chat Completions `tool` messages only accept text content.
    // Any non-text content parts (image_url, audio_url, video_url) would be
    // rejected by the API with a 400. Detect multimodal tool output and
    // force the `extract_text` path in that case, regardless of the caller's
    // `toolMessageConversion` setting. For pure-text tool results we honor
    // the configured strategy (or fall through to the default content-part
    // array when it is unset).
    const hasNonTextPart = message.content.some((p) => p.type !== 'text' && p.type !== 'think');
    const effectiveConversion: ToolMessageConversion = hasNonTextPart
      ? 'extract_text'
      : toolMessageConversion;

    if (effectiveConversion !== null) {
      result.content = convertToolMessageContent(message, effectiveConversion);
    } else {
      // Pure-text tool result with no conversion configured: serialize via the
      // generic content-part path so single-text messages become a plain string.
      const firstPart = nonThinkParts[0];
      if (nonThinkParts.length === 1 && firstPart?.type === 'text') {
        result.content = firstPart.text;
      } else if (nonThinkParts.length > 0) {
        result.content = nonThinkParts
          .map((p) => convertContentPart(p))
          .filter((p): p is OpenAIContentPart => p !== null);
      }
    }
  } else {
    // content: serialize to string if single text, array otherwise
    const firstPart = nonThinkParts[0];
    if (nonThinkParts.length === 1 && firstPart?.type === 'text') {
      result.content = firstPart.text;
    } else if (nonThinkParts.length > 0) {
      result.content = nonThinkParts
        .map((p) => convertContentPart(p))
        .filter((p): p is OpenAIContentPart => p !== null);
    }
  }

  if (message.name !== undefined) {
    result.name = message.name;
  }

  if (message.toolCalls.length > 0) {
    result.tool_calls = message.toolCalls.map((tc) => ({
      type: tc.type,
      id: tc.id,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
  }

  if (message.toolCallId !== undefined) {
    result.tool_call_id = message.toolCallId;
  }

  // Place reasoning content under the configured key (e.g. "reasoning_content" for DeepSeek)
  if (reasoningContent && reasoningKey) {
    result[reasoningKey] = reasoningContent;
  }

  return result;
}

// ── OpenAILegacyStreamedMessage ─────────────────────────────────────

export class OpenAILegacyStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(
    response: OpenAI.Chat.ChatCompletion | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    isStream: boolean,
    reasoningKey: string | undefined,
  ) {
    if (isStream) {
      this._iter = this._convertStreamResponse(
        response as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
        reasoningKey,
      );
    } else {
      this._iter = this._convertNonStreamResponse(
        response as OpenAI.Chat.ChatCompletion,
        reasoningKey,
      );
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
    reasoningKey: string | undefined,
  ): AsyncGenerator<StreamedMessagePart> {
    this._id = response.id;
    if (response.usage) {
      this._usage = extractUsage(response.usage) ?? null;
    }
    this._captureFinishReason(response.choices[0]?.finish_reason ?? null);

    const message = response.choices[0]?.message;
    if (!message) return;

    // Reasoning content via configured key
    if (reasoningKey) {
      const rc = (message as unknown as Record<string, unknown>)[reasoningKey];
      if (typeof rc === 'string' && rc) {
        yield { type: 'think', think: rc } satisfies StreamedMessagePart;
      }
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
    reasoningKey: string | undefined,
  ): AsyncGenerator<StreamedMessagePart> {
    const bufferedToolCalls = new Map<number | string, BufferedStreamToolCall>();

    try {
      for await (const chunk of response) {
        if (chunk.id) {
          this._id = chunk.id;
        }

        if (chunk.usage) {
          this._usage = extractUsage(chunk.usage) ?? null;
        }

        if (!chunk.choices || chunk.choices.length === 0) {
          continue;
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        // Capture finish_reason whenever the chunk carries one. Chat
        // Completions only sets it on the final chunk for a given choice.
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          this._captureFinishReason(choice.finish_reason);
        }

        const delta = choice.delta;

        // Reasoning content via configured key
        if (reasoningKey) {
          const rc = (delta as unknown as Record<string, unknown>)[reasoningKey];
          if (typeof rc === 'string' && rc) {
            yield { type: 'think', think: rc } satisfies StreamedMessagePart;
          }
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

// ── OpenAILegacy ChatProvider ────────────────────────────────────────

export class OpenAILegacyChatProvider implements RetryableChatProvider {
  readonly name: string = 'openai';

  private _model: string;
  private _stream: boolean;
  private _apiKey: string | undefined;
  private _baseUrl: string | undefined;
  private _reasoningKey: string | undefined;
  private _reasoningEffort: string | undefined;
  private _generationKwargs: OpenAILegacyGenerationKwargs;
  private _toolMessageConversion: ToolMessageConversion;
  private _client: OpenAI;
  private _httpClient: unknown;

  constructor(options: OpenAILegacyOptions) {
    this._apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'];
    this._baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this._model = options.model;
    this._stream = options.stream ?? true;
    this._reasoningKey = options.reasoningKey;
    this._reasoningEffort = undefined;
    this._generationKwargs = {};
    if (options.maxTokens !== undefined) {
      this._generationKwargs.max_tokens = options.maxTokens;
    }
    this._toolMessageConversion = options.toolMessageConversion ?? null;
    this._httpClient = options.httpClient;

    const clientOpts: Record<string, unknown> = {
      apiKey: this._apiKey,
      baseURL: this._baseUrl,
    };
    if (this._httpClient !== undefined) {
      clientOpts['httpClient'] = this._httpClient;
    }
    this._client = new OpenAI(clientOpts as ConstructorParameters<typeof OpenAI>[0]);
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    return reasoningEffortToThinkingEffort(this._reasoningEffort);
  }

  get modelParameters(): Record<string, unknown> {
    return {
      model: this._model,
      baseUrl: this._baseUrl,
      ...this._generationKwargs,
    };
  }

  getCapability(model?: string): ModelCapability {
    const name = (model ?? this._model).toLowerCase();
    // o-series (o1, o1-mini, o1-preview, o3, o3-mini, o4-mini, …): reasoning family.
    if (/^o\d/.test(name)) {
      return {
        image_in: false,
        video_in: false,
        audio_in: false,
        thinking: true,
        tool_use: true,
        max_context_tokens: 0,
      };
    }
    // GPT-4o / GPT-4-turbo / GPT-4.1 / GPT-4.5: vision + tools.
    if (
      name.startsWith('gpt-4o') ||
      name.startsWith('gpt-4-turbo') ||
      name.startsWith('gpt-4.1') ||
      name.startsWith('gpt-4.5')
    ) {
      return {
        image_in: true,
        video_in: false,
        audio_in: false,
        thinking: false,
        tool_use: true,
        max_context_tokens: 0,
      };
    }
    // GPT-3.5 turbo: text-only but supports tool calls.
    if (name.startsWith('gpt-3.5-turbo')) {
      return {
        image_in: false,
        video_in: false,
        audio_in: false,
        thinking: false,
        tool_use: true,
        max_context_tokens: 0,
      };
    }
    return UNKNOWN_CAPABILITY;
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
      messages.push(convertMessage(msg, this._reasoningKey, this._toolMessageConversion));
    }

    const kwargs: Record<string, unknown> = {
      ...this._generationKwargs,
    };

    // Determine reasoning_effort
    let reasoningEffort: string | undefined = this._reasoningEffort;

    // Auto-enable reasoning_effort when the history contains ThinkPart but reasoning
    // was not explicitly configured. This prevents server validation errors from APIs
    // (e.g. One API) that require reasoning_effort when messages contain reasoning_content.
    // See: https://github.com/MoonshotAI/kimi-cli/issues/1616
    if (reasoningEffort === undefined && this._reasoningKey) {
      const hasThinkPart = history.some((message) =>
        message.content.some((part) => part.type === 'think'),
      );
      if (hasThinkPart) {
        reasoningEffort = 'medium';
      }
    }

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
      createParams['tools'] = tools.map((t) => toolToOpenAI(t));
    }

    if (this._stream) {
      createParams['stream_options'] = { include_usage: true };
    }

    if (reasoningEffort !== undefined) {
      createParams['reasoning_effort'] = reasoningEffort;
    }

    try {
      const response = (await this._client.chat.completions.create(
        createParams as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        options?.signal ? { signal: options.signal } : undefined,
      )) as unknown as OpenAI.Chat.ChatCompletion | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
      return new OpenAILegacyStreamedMessage(response, this._stream, this._reasoningKey);
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    }
  }

  onRetryableError(_error: Error): boolean {
    // Replace client to get a fresh connection.
    // OpenAI TS SDK v6 uses Node.js built-in fetch with no persistent connection pool,
    // so no explicit close() is needed. If a future SDK version exposes close(), call it here.
    const clientOpts: Record<string, unknown> = {
      apiKey: this._apiKey,
      baseURL: this._baseUrl,
    };
    if (this._httpClient !== undefined) {
      clientOpts['httpClient'] = this._httpClient;
    }
    this._client = new OpenAI(clientOpts as ConstructorParameters<typeof OpenAI>[0]);
    return true;
  }

  withThinking(effort: ThinkingEffort): OpenAILegacyChatProvider {
    const reasoningEffort = thinkingEffortToReasoningEffort(effort);
    const clone = this._clone();
    clone._reasoningEffort = reasoningEffort;
    return clone;
  }

  withGenerationKwargs(kwargs: OpenAILegacyGenerationKwargs): OpenAILegacyChatProvider {
    const clone = this._clone();
    clone._generationKwargs = { ...clone._generationKwargs, ...kwargs };
    return clone;
  }

  private _clone(): OpenAILegacyChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as OpenAILegacyChatProvider,
      this,
    );
    clone._generationKwargs = { ...this._generationKwargs };
    return clone;
  }
}
