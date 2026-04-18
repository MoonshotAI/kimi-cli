import Anthropic, {
  APIConnectionError as AnthropicConnectionError,
  APIConnectionTimeoutError as AnthropicTimeoutError,
  APIError as AnthropicAPIError,
  AnthropicError,
} from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  MessageCreateParams,
  MessageParam,
  MessageStreamEvent,
  RawContentBlockDeltaEvent,
  RawContentBlockStartEvent,
  RawMessageStartEvent,
  TextBlockParam,
  ThinkingBlockParam,
  Tool as AnthropicTool,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages.js';

import { UNKNOWN_CAPABILITY, type ModelCapability } from '../capability.js';
import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
} from '../errors.js';
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

/**
 * Normalize an Anthropic `stop_reason` string to the unified
 * {@link FinishReason} enum.
 *
 * Source: `message.stop_reason` (non-stream) or the last `message_delta`
 * event's `delta.stop_reason` (stream).
 */
function normalizeAnthropicStopReason(raw: string | null | undefined): {
  finishReason: FinishReason | null;
  rawFinishReason: string | null;
} {
  if (raw === null || raw === undefined) {
    return { finishReason: null, rawFinishReason: null };
  }
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return { finishReason: 'completed', rawFinishReason: raw };
    case 'max_tokens':
      return { finishReason: 'truncated', rawFinishReason: raw };
    case 'tool_use':
      return { finishReason: 'tool_calls', rawFinishReason: raw };
    case 'pause_turn':
      return { finishReason: 'paused', rawFinishReason: raw };
    case 'refusal':
      return { finishReason: 'filtered', rawFinishReason: raw };
    default:
      return { finishReason: 'other', rawFinishReason: raw };
  }
}

// ── Types ─────────────────────────────────────────────────────────────

export interface AnthropicOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  defaultMaxTokens?: number | undefined;
  betaFeatures?: string[] | undefined;
  metadata?: Record<string, string> | undefined;
  /** Use streaming API. Defaults to true. Set to false for non-streaming (test/fallback). */
  stream?: boolean | undefined;
}

interface AnthropicGenerationKwargs {
  max_tokens?: number | undefined;
  temperature?: number | undefined;
  top_k?: number | undefined;
  top_p?: number | undefined;
  thinking?: MessageCreateParams['thinking'] | undefined;
  betaFeatures?: string[] | undefined;
}

// ── Cache control injection ──────────────────────────────────────────

const CACHE_CONTROL = { type: 'ephemeral' as const };

type CacheableBlock = ContentBlockParam & { cache_control?: { type: 'ephemeral' } };

/**
 * Content block types that support cache_control injection.
 */
const CACHEABLE_TYPES = new Set([
  'text',
  'image',
  'document',
  'search_result',
  'tool_use',
  'tool_result',
  'server_tool_use',
  'web_search_tool_result',
]);

function injectCacheControlOnLastBlock(messages: MessageParam[]): void {
  const lastMessage = messages.at(-1);
  if (lastMessage === undefined) return;
  const content = lastMessage.content;
  if (!Array.isArray(content) || content.length === 0) return;
  const lastBlock = content.at(-1) as CacheableBlock | undefined;
  if (lastBlock === undefined) return;
  if (CACHEABLE_TYPES.has(lastBlock.type)) {
    lastBlock.cache_control = CACHE_CONTROL;
  }
}

// ── Image URL conversion ─────────────────────────────────────────────

interface AnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; data: string; media_type: string } | { type: 'url'; url: string };
  cache_control?: { type: 'ephemeral' };
}

const SUPPORTED_B64_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function imageUrlPartToAnthropic(url: string): AnthropicImageBlock {
  if (url.startsWith('data:')) {
    const withoutScheme = url.slice(5);
    const parts = withoutScheme.split(';base64,', 2);
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new ChatProviderError(`Invalid data URL for image: ${url}`);
    }
    const mediaType = parts[0];
    const data = parts[1];
    if (!SUPPORTED_B64_MEDIA_TYPES.has(mediaType)) {
      throw new ChatProviderError(
        `Unsupported media type for base64 image: ${mediaType}, url: ${url}`,
      );
    }
    return {
      type: 'image',
      source: { type: 'base64', data, media_type: mediaType },
    };
  }
  return {
    type: 'image',
    source: { type: 'url', url },
  };
}

// ── Tool conversion ──────────────────────────────────────────────────

interface AnthropicToolParam extends AnthropicTool {
  cache_control?: { type: 'ephemeral' } | null;
}

function convertTool(tool: Tool): AnthropicToolParam {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as AnthropicTool['input_schema'],
  };
}

// ── Tool result conversion ───────────────────────────────────────────

function toolResultToBlock(toolCallId: string, content: ContentPart[]): ToolResultBlockParam {
  const blocks: Array<TextBlockParam | AnthropicImageBlock> = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) {
        blocks.push({ type: 'text', text: part.text });
      }
    } else if (part.type === 'image_url') {
      blocks.push(imageUrlPartToAnthropic(part.imageUrl.url));
    }
    // Other types not supported by Anthropic in tool results
  }
  return {
    type: 'tool_result',
    tool_use_id: toolCallId,
    content: blocks,
  } as ToolResultBlockParam;
}

// ── Message conversion ───────────────────────────────────────────────

function convertMessage(message: Message): MessageParam {
  const role = message.role;

  // system role -> <system>...</system> wrapped user message
  if (role === 'system') {
    const text = message.content
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    return {
      role: 'user',
      content: [{ type: 'text', text: `<system>${text}</system>` }],
    };
  }

  // tool role -> ToolResultBlockParam in user message
  if (role === 'tool') {
    if (message.toolCallId === undefined) {
      throw new ChatProviderError('Tool message missing `toolCallId`.');
    }
    const block = toolResultToBlock(message.toolCallId, message.content);
    return { role: 'user', content: [block as ContentBlockParam] };
  }

  // user or assistant
  const blocks: ContentBlockParam[] = [];
  for (const part of message.content) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text } satisfies TextBlockParam);
    } else if (part.type === 'image_url') {
      blocks.push(imageUrlPartToAnthropic(part.imageUrl.url) as unknown as ContentBlockParam);
    } else if (part.type === 'think') {
      // ThinkPart with encrypted -> ThinkingBlockParam; no encrypted -> skip
      if (part.encrypted === undefined) {
        continue;
      }
      blocks.push({
        type: 'thinking',
        thinking: part.think,
        signature: part.encrypted,
      } satisfies ThinkingBlockParam);
    }
    // audio_url, video_url: not supported by Anthropic, skip
  }

  // Tool calls -> ToolUseBlockParam
  if (message.toolCalls.length > 0) {
    for (const tc of message.toolCalls) {
      let toolInput: Record<string, unknown> = {};
      if (tc.function.arguments) {
        try {
          const parsed: unknown = JSON.parse(tc.function.arguments);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            toolInput = parsed as Record<string, unknown>;
          } else {
            throw new ChatProviderError('Tool call arguments must be a JSON object.');
          }
        } catch (error) {
          if (error instanceof ChatProviderError) throw error;
          throw new ChatProviderError('Tool call arguments must be valid JSON.');
        }
      }
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: toolInput,
      } satisfies ToolUseBlockParam);
    }
  }

  return { role: role, content: blocks };
}

// ── Error conversion ─────────────────────────────────────────────────

export function convertAnthropicError(error: unknown): ChatProviderError {
  // Check timeout before connection (APIConnectionTimeoutError extends APIConnectionError)
  if (error instanceof AnthropicTimeoutError) {
    return new APITimeoutError(error.message);
  }
  if (error instanceof AnthropicConnectionError) {
    return new APIConnectionError(error.message);
  }
  // APIError with a status code => status error
  if (error instanceof AnthropicAPIError && typeof error.status === 'number') {
    const reqId = error.requestID ?? null;
    return new APIStatusError(error.status, error.message, reqId);
  }
  if (error instanceof AnthropicError) {
    return new ChatProviderError(`Anthropic error: ${error.message}`);
  }
  if (error instanceof Error) {
    return new ChatProviderError(`Error: ${error.message}`);
  }
  return new ChatProviderError(`Error: ${String(error)}`);
}

// ── AnthropicStreamedMessage ─────────────────────────────────────────

class AnthropicStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage = {
    inputOther: 0,
    output: 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
  };
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(response: unknown, isStream: boolean) {
    if (isStream) {
      this._iter = this._convertStreamResponse(response as AsyncIterable<MessageStreamEvent>);
    } else {
      this._iter = this._convertNonStreamResponse(
        response as {
          id: string;
          stop_reason?: string | null;
          usage: {
            input_tokens: number;
            output_tokens: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          content: Array<{
            type: string;
            text?: string;
            thinking?: string;
            signature?: string;
            data?: string;
            id?: string;
            name?: string;
            input?: unknown;
          }>;
        },
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

  private _captureStopReason(raw: string | null | undefined): void {
    const normalized = normalizeAnthropicStopReason(raw);
    this._finishReason = normalized.finishReason;
    this._rawFinishReason = normalized.rawFinishReason;
  }

  private _extractUsage(usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  }): void {
    this._usage = {
      inputOther: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      inputCacheRead: usage.cache_read_input_tokens ?? 0,
      inputCacheCreation: usage.cache_creation_input_tokens ?? 0,
    };
  }

  private async *_convertNonStreamResponse(response: {
    id: string;
    stop_reason?: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    content: Array<{
      type: string;
      text?: string;
      thinking?: string;
      signature?: string;
      data?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
  }): AsyncGenerator<StreamedMessagePart> {
    this._id = response.id;
    this._extractUsage(response.usage);
    this._captureStopReason(response.stop_reason);

    for (const block of response.content) {
      switch (block.type) {
        case 'text':
          if (block.text !== undefined) {
            yield { type: 'text', text: block.text };
          }
          break;
        case 'thinking':
          yield block.signature !== undefined
            ? { type: 'think' as const, think: block.thinking ?? '', encrypted: block.signature }
            : { type: 'think' as const, think: block.thinking ?? '' };
          break;
        case 'redacted_thinking':
          yield block.data !== undefined
            ? { type: 'think' as const, think: '', encrypted: block.data }
            : { type: 'think' as const, think: '' };
          break;
        case 'tool_use':
          yield {
            type: 'function',
            id: block.id ?? crypto.randomUUID(),
            function: {
              name: block.name ?? '',
              arguments: block.input !== undefined ? JSON.stringify(block.input) : null,
            },
          } satisfies ToolCall;
          break;
      }
    }
  }

  private async *_convertStreamResponse(
    response: AsyncIterable<MessageStreamEvent>,
  ): AsyncGenerator<StreamedMessagePart> {
    try {
      for await (const event of response) {
        const evt = event as unknown as Record<string, unknown>;
        const eventType = evt['type'] as string;

        if (eventType === 'message_start') {
          const startEvt = evt as unknown as RawMessageStartEvent;
          this._id = startEvt.message.id;
          this._extractUsage(
            startEvt.message.usage as {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            },
          );
        } else if (eventType === 'content_block_start') {
          const blockEvt = evt as unknown as RawContentBlockStartEvent;
          const block = blockEvt.content_block;
          const blockIndex = blockEvt.index;
          // eslint-disable-next-line typescript-eslint/switch-exhaustiveness-check
          switch (block.type) {
            case 'text':
              yield { type: 'text', text: block.text };
              break;
            case 'thinking':
              yield { type: 'think', think: block.thinking };
              break;
            case 'redacted_thinking':
              yield {
                type: 'think',
                think: '',
                encrypted: (block as unknown as { data: string }).data,
              };
              break;
            case 'tool_use':
              yield {
                type: 'function',
                id: block.id,
                function: {
                  name: block.name,
                  arguments: '',
                },
                // Carry the Anthropic block index so parallel tool_use
                // blocks' interleaved input_json_delta chunks can be routed
                // to the correct ToolCall by the generate loop.
                _streamIndex: blockIndex,
              } satisfies ToolCall;
              break;
          }
        } else if (eventType === 'content_block_delta') {
          const deltaEvt = evt as unknown as RawContentBlockDeltaEvent;
          const delta = deltaEvt.delta;
          const blockIndex = deltaEvt.index;
          // eslint-disable-next-line typescript-eslint/switch-exhaustiveness-check
          switch (delta.type) {
            case 'text_delta':
              yield { type: 'text', text: delta.text };
              break;
            case 'thinking_delta':
              yield { type: 'think', think: delta.thinking };
              break;
            case 'input_json_delta':
              yield {
                type: 'tool_call_part',
                argumentsPart: delta.partial_json,
                // Carry the Anthropic block index so this delta is routed
                // to the matching ToolCall (parallel tool_use support).
                index: blockIndex,
              };
              break;
            case 'signature_delta':
              yield {
                type: 'think',
                think: '',
                encrypted: delta.signature,
              };
              break;
          }
        } else if (eventType === 'message_delta') {
          // Update usage from delta
          const deltaUsage = (evt as { usage?: Record<string, unknown> }).usage;
          if (deltaUsage !== undefined) {
            if (typeof deltaUsage['output_tokens'] === 'number') {
              this._usage.output = deltaUsage['output_tokens'];
            }
            if (typeof deltaUsage['cache_read_input_tokens'] === 'number') {
              this._usage.inputCacheRead = deltaUsage['cache_read_input_tokens'];
            }
            if (typeof deltaUsage['cache_creation_input_tokens'] === 'number') {
              this._usage.inputCacheCreation = deltaUsage['cache_creation_input_tokens'];
            }
            if (typeof deltaUsage['input_tokens'] === 'number') {
              this._usage.inputOther = deltaUsage['input_tokens'];
            }
          }
          // The terminal `stop_reason` lives on `delta.stop_reason` of the
          // last `message_delta` event for this response. Capture it here.
          //
          // Accept `null` explicitly: if the key is present we forward the
          // value (including null) to `_captureStopReason`, which maps it to
          // `{null, null}`. Only a missing key skips the capture. This avoids
          // a stale prior capture persisting after an explicit null reset.
          const messageDeltaPayload = (evt as { delta?: Record<string, unknown> }).delta;
          if (messageDeltaPayload !== undefined && 'stop_reason' in messageDeltaPayload) {
            this._captureStopReason(
              messageDeltaPayload['stop_reason'] as string | null | undefined,
            );
          }
        }
        // message_stop: nothing to do
      }
    } catch (error: unknown) {
      throw convertAnthropicError(error);
    }
  }
}

// ── Anthropic ChatProvider ───────────────────────────────────────────

export class AnthropicChatProvider implements RetryableChatProvider {
  readonly name: string = 'anthropic';

  private _model: string;
  private _stream: boolean;
  private _client: Anthropic;
  private _generationKwargs: AnthropicGenerationKwargs;
  private _metadata: Record<string, string> | undefined;
  private _apiKey: string;
  private _baseUrl: string | undefined;

  constructor(options: AnthropicOptions) {
    this._model = options.model;
    this._stream = options.stream ?? true;
    this._metadata = options.metadata;
    this._apiKey = options.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
    this._baseUrl = options.baseUrl;
    this._client = new Anthropic({
      apiKey: this._apiKey,
      ...(this._baseUrl ? { baseURL: this._baseUrl } : {}),
    });
    this._generationKwargs = {
      max_tokens: options.defaultMaxTokens ?? 4096,
      betaFeatures: options.betaFeatures ?? ['interleaved-thinking-2025-05-14'],
    };
  }

  /**
   * Rebuild the Anthropic client to recover from transient connection / stream
   * errors. Called by the retry loop before a retry attempt.
   *
   * The `@anthropic-ai/sdk` uses Node.js built-in `fetch` with no persistent
   * connection pool, so swapping the instance is enough to drop any dangling
   * stream state. If a future SDK version exposes `close()`, call it here
   * before replacing `_client`.
   */
  onRetryableError(_error: Error): boolean {
    this._client = new Anthropic({
      apiKey: this._apiKey,
      ...(this._baseUrl ? { baseURL: this._baseUrl } : {}),
    });
    return true;
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    const thinkingConfig = this._generationKwargs.thinking;
    if (thinkingConfig === undefined || thinkingConfig === null) {
      return null;
    }
    if (thinkingConfig.type === 'disabled') {
      return 'off';
    }
    if (thinkingConfig.type === 'adaptive') {
      return 'high';
    }
    // budget-based
    const budget = (thinkingConfig as { budget_tokens?: number }).budget_tokens ?? 0;
    if (budget <= 1024) {
      return 'low';
    }
    if (budget <= 4096) {
      return 'medium';
    }
    return 'high';
  }

  get modelParameters(): Record<string, unknown> {
    return {
      model: this._model,
      ...this._generationKwargs,
    };
  }

  getCapability(model?: string): ModelCapability {
    const name = (model ?? this._model).toLowerCase();
    // Claude 3 family (haiku / sonnet / opus, incl. 3.5 / 3.7 variants):
    // vision + tools, no audio, no extended thinking.
    if (name.startsWith('claude-3-') || name.startsWith('claude-3.5-') || name.startsWith('claude-3.7-')) {
      return {
        image_in: true,
        video_in: false,
        audio_in: false,
        thinking: false,
        tool_use: true,
        max_context_tokens: 0,
      };
    }
    // Claude 4 family (opus-4 / sonnet-4 / haiku-4, incl. point releases):
    // vision + tools + extended thinking.
    if (name.startsWith('claude-opus-4') || name.startsWith('claude-sonnet-4') || name.startsWith('claude-haiku-4')) {
      return {
        image_in: true,
        video_in: false,
        audio_in: false,
        thinking: true,
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
    // Build system param
    const system: TextBlockParam[] | undefined = systemPrompt
      ? [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: CACHE_CONTROL,
          } as TextBlockParam,
        ]
      : undefined;

    // Convert messages
    const messages: MessageParam[] = [];
    for (const msg of history) {
      messages.push(convertMessage(msg));
    }

    // Inject cache_control on last content block of last message
    injectCacheControlOnLastBlock(messages);

    // Build generation kwargs (excluding betaFeatures)
    const kwargs: Record<string, unknown> = {};
    if (this._generationKwargs.max_tokens !== undefined) {
      kwargs['max_tokens'] = this._generationKwargs.max_tokens;
    }
    if (this._generationKwargs.temperature !== undefined) {
      kwargs['temperature'] = this._generationKwargs.temperature;
    }
    if (this._generationKwargs.top_k !== undefined) {
      kwargs['top_k'] = this._generationKwargs.top_k;
    }
    if (this._generationKwargs.top_p !== undefined) {
      kwargs['top_p'] = this._generationKwargs.top_p;
    }
    if (this._generationKwargs.thinking !== undefined) {
      kwargs['thinking'] = this._generationKwargs.thinking;
    }

    // Build beta headers
    const betas = this._generationKwargs.betaFeatures ?? [];
    const extraHeaders: Record<string, string> = {};
    if (betas.length > 0) {
      extraHeaders['anthropic-beta'] = betas.join(',');
    }

    // Convert tools
    const anthropicTools: AnthropicToolParam[] = tools.map((t) => convertTool(t));
    if (anthropicTools.length > 0) {
      const lastTool = anthropicTools.at(-1);
      if (lastTool !== undefined) {
        lastTool.cache_control = CACHE_CONTROL;
      }
    }

    // Build the create params
    const createParams: Record<string, unknown> = {
      model: this._model,
      messages,
      ...kwargs,
    };

    if (system !== undefined) {
      createParams['system'] = system;
    }

    if (anthropicTools.length > 0) {
      createParams['tools'] = anthropicTools;
    }

    if (this._metadata !== undefined) {
      createParams['metadata'] = this._metadata;
    }

    const requestOptions: Record<string, unknown> = {};
    if (Object.keys(extraHeaders).length > 0) {
      requestOptions['headers'] = extraHeaders;
    }
    if (options?.signal) {
      requestOptions['signal'] = options.signal;
    }
    const finalRequestOptions = Object.keys(requestOptions).length > 0 ? requestOptions : undefined;

    if (this._stream) {
      // Streaming mode: use client.messages.stream() which returns an AsyncIterable<MessageStreamEvent>
      try {
        const stream = this._client.messages.stream(
          createParams as unknown as MessageCreateParams,
          finalRequestOptions,
        );
        return new AnthropicStreamedMessage(stream, true);
      } catch (error: unknown) {
        throw convertAnthropicError(error);
      }
    }

    // Non-streaming fallback
    try {
      const response = await this._client.messages.create(
        { ...createParams, stream: false } as unknown as MessageCreateParams,
        finalRequestOptions,
      );
      return new AnthropicStreamedMessage(response, false);
    } catch (error: unknown) {
      throw convertAnthropicError(error);
    }
  }

  private _useAdaptiveThinking(): boolean {
    const model = this._model.toLowerCase();
    return model.includes('opus-4.6') || model.includes('opus-4-6');
  }

  withThinking(effort: ThinkingEffort): AnthropicChatProvider {
    let thinkingConfig: MessageCreateParams['thinking'];
    let newBetas = [...(this._generationKwargs.betaFeatures ?? [])];

    if (this._useAdaptiveThinking()) {
      // Opus 4.6+: adaptive thinking
      if (effort === 'off') {
        thinkingConfig = { type: 'disabled' };
      } else {
        thinkingConfig = { type: 'adaptive' } as MessageCreateParams['thinking'];
      }
      // Remove interleaved-thinking beta for adaptive
      newBetas = newBetas.filter((b) => b !== 'interleaved-thinking-2025-05-14');
    } else {
      // Pre-4.6: budget-based thinking
      switch (effort) {
        case 'off':
          thinkingConfig = { type: 'disabled' };
          break;
        case 'low':
          thinkingConfig = { type: 'enabled', budget_tokens: 1024 };
          break;
        case 'medium':
          thinkingConfig = { type: 'enabled', budget_tokens: 4096 };
          break;
        case 'high':
          thinkingConfig = { type: 'enabled', budget_tokens: 32_000 };
          break;
      }
    }

    return this._withGenerationKwargs({
      thinking: thinkingConfig,
      betaFeatures: newBetas,
    });
  }

  withGenerationKwargs(kwargs: Partial<AnthropicGenerationKwargs>): AnthropicChatProvider {
    return this._withGenerationKwargs(kwargs);
  }

  private _withGenerationKwargs(kwargs: Partial<AnthropicGenerationKwargs>): AnthropicChatProvider {
    const clone = this._clone();
    clone._generationKwargs = { ...clone._generationKwargs, ...kwargs };
    return clone;
  }

  private _clone(): AnthropicChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as AnthropicChatProvider,
      this,
    );
    clone._generationKwargs = { ...this._generationKwargs };
    return clone;
  }
}
