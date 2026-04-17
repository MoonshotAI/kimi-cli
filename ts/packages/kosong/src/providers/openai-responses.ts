import OpenAI from 'openai';

import { UNKNOWN_CAPABILITY, type ModelCapability } from '../capability.js';
import type { ContentPart, Message, StreamedMessagePart, ToolCall } from '../message.js';
import { extractText } from '../message.js';
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
  convertOpenAIError,
  type ToolMessageConversion,
  reasoningEffortToThinkingEffort,
  thinkingEffortToReasoningEffort,
} from './openai-common.js';

/**
 * Normalize the Responses API status / incomplete_details into the unified
 * {@link FinishReason} enum.
 *
 * Note: the Responses API has no `tool_calls`-style status. When a response
 * completes with `function_call` items inline the status is still
 * `'completed'`; callers detect tool calls via `message.toolCalls.length`,
 * not via finishReason.
 */
function normalizeResponsesFinishReason(
  status: string | null | undefined,
  incompleteReason: string | null | undefined,
): { finishReason: FinishReason | null; rawFinishReason: string | null } {
  if (status === null || status === undefined) {
    return { finishReason: null, rawFinishReason: null };
  }
  if (status === 'completed') {
    return { finishReason: 'completed', rawFinishReason: 'completed' };
  }
  if (status === 'incomplete') {
    if (incompleteReason === 'max_output_tokens') {
      return { finishReason: 'truncated', rawFinishReason: 'max_output_tokens' };
    }
    if (incompleteReason === 'content_filter') {
      return { finishReason: 'filtered', rawFinishReason: 'content_filter' };
    }
    return {
      finishReason: 'other',
      rawFinishReason: incompleteReason ?? 'incomplete',
    };
  }
  if (status === 'failed') {
    return { finishReason: 'other', rawFinishReason: 'failed' };
  }
  return { finishReason: null, rawFinishReason: null };
}

// ── Types ─────────────────────────────────────────────────────────────

export interface OpenAIResponsesOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  maxOutputTokens?: number | undefined;
  httpClient?: unknown;
  toolMessageConversion?: ToolMessageConversion | undefined;
}

export interface OpenAIResponsesGenerationKwargs {
  max_output_tokens?: number | undefined;
  temperature?: number | undefined;
  top_p?: number | undefined;
  reasoning_effort?: string | undefined;
  [key: string]: unknown;
}

// ── Known OpenAI official models ─────────────────────────────────────

const OPENAI_MODELS = new Set([
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-5-codex',
  'o1',
  'o1-mini',
  'o1-pro',
  'o3',
  'o3-mini',
  'o3-pro',
  'o4-mini',
]);

function isOpenAIModel(modelName: string): boolean {
  if (OPENAI_MODELS.has(modelName)) return true;
  // Match partial prefixes (e.g. "gpt-4.1-2025-04-14")
  for (const m of OPENAI_MODELS) {
    if (modelName.startsWith(m + '-')) return true;
  }
  return false;
}

// ── Input conversion types ───────────────────────────────────────────

interface ResponseInputItem {
  [key: string]: unknown;
}

interface ResponseToolParam {
  type: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

// ── Message conversion ───────────────────────────────────────────────

function contentPartsToInputItems(parts: ContentPart[]): unknown[] {
  const items: unknown[] = [];
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        if (part.text) {
          items.push({ type: 'input_text', text: part.text });
        }
        break;
      case 'image_url':
        items.push({
          type: 'input_image',
          detail: 'auto',
          image_url: part.imageUrl.url,
        });
        break;
      case 'audio_url': {
        const mapped = mapAudioUrlToInputItem(part.audioUrl.url);
        if (mapped !== null) {
          items.push(mapped);
        }
        break;
      }
      case 'think':
      case 'video_url':
        // think: handled separately. video_url: not supported by Responses API.
        break;
    }
  }
  return items;
}

function contentPartsToOutputItems(parts: ContentPart[]): unknown[] {
  const items: unknown[] = [];
  for (const part of parts) {
    if (part.type === 'text' && part.text) {
      items.push({ type: 'output_text', text: part.text, annotations: [] });
    }
  }
  return items;
}

function messageContentToFunctionOutputItems(content: ContentPart[]): string | unknown[] {
  const items: unknown[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'text':
        if (part.text) {
          items.push({ type: 'input_text', text: part.text });
        }
        break;
      case 'image_url':
        items.push({ type: 'input_image', image_url: part.imageUrl.url });
        break;
      case 'audio_url': {
        // Tool results can legitimately include audio (e.g. a TTS tool
        // returning generated speech). The user-message path already
        // encodes audio via `mapAudioUrlToInputItem`; without the same
        // branch here, any audio returned by a tool would be silently
        // dropped on the next turn (Codex Round 9 P2).
        const mapped = mapAudioUrlToInputItem(part.audioUrl.url);
        if (mapped !== null) {
          items.push(mapped);
        }
        break;
      }
      case 'think':
      case 'video_url':
        // think / video_url still intentionally skipped: the Responses
        // API has no representation for them inside a function_call_output.
        break;
    }
  }
  return items;
}

function mapAudioUrlToInputItem(url: string): unknown {
  if (url.startsWith('data:audio/')) {
    try {
      const parts = url.split(',', 2);
      if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return null;
      const header = parts[0];
      const b64 = parts[1];
      const subtypePart = header.split('/')[1];
      if (subtypePart === undefined) return null;
      const [subtypeHead = ''] = subtypePart.split(';');
      const subtype = subtypeHead.toLowerCase();
      const ext =
        subtype === 'mp3' || subtype === 'mpeg' ? 'mp3' : subtype === 'wav' ? 'wav' : null;
      if (ext === null) return null;
      return { type: 'input_file', file_data: b64, filename: `inline.${ext}` };
    } catch {
      return null;
    }
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return { type: 'input_file', file_url: url };
  }
  return null;
}

function convertMessage(
  message: Message,
  modelName: string,
  toolMessageConversion: ToolMessageConversion,
): ResponseInputItem[] {
  let role: string = message.role;
  if (isOpenAIModel(modelName) && role === 'system') {
    role = 'developer';
  }

  // tool role -> function_call_output
  if (role === 'tool') {
    const callId = message.toolCallId ?? '';
    const output: string | unknown[] =
      toolMessageConversion === 'extract_text'
        ? extractText(message)
        : messageContentToFunctionOutputItems(message.content);
    return [
      {
        call_id: callId,
        output,
        type: 'function_call_output',
      },
    ];
  }

  const result: ResponseInputItem[] = [];

  // Process content parts
  if (message.content.length > 0) {
    const pendingParts: ContentPart[] = [];

    const flushPendingParts = (): void => {
      if (pendingParts.length === 0) return;
      if (role === 'assistant') {
        result.push({
          content: contentPartsToOutputItems(pendingParts),
          role,
          type: 'message',
        });
      } else {
        result.push({
          content: contentPartsToInputItems(pendingParts),
          role,
          type: 'message',
        });
      }
      pendingParts.length = 0;
    };

    let i = 0;
    const n = message.content.length;
    while (i < n) {
      const part = message.content[i];
      if (part === undefined) break;
      if (part.type === 'think') {
        // Flush accumulated non-reasoning parts first
        flushPendingParts();
        // Aggregate consecutive ThinkParts with the same `encrypted` value
        const encryptedValue = part.encrypted;
        const summaries: unknown[] = [{ type: 'summary_text', text: part.think || '' }];
        i += 1;
        while (i < n) {
          const nextPart = message.content[i];
          if (nextPart === undefined) break;
          if (nextPart.type !== 'think') break;
          if (nextPart.encrypted !== encryptedValue) break;
          summaries.push({ type: 'summary_text', text: nextPart.think || '' });
          i += 1;
        }
        result.push({
          summary: summaries,
          type: 'reasoning',
          encrypted_content: encryptedValue,
        });
      } else {
        pendingParts.push(part);
        i += 1;
      }
    }

    // Handle remaining trailing non-reasoning parts
    flushPendingParts();
  }

  // Handle tool calls
  for (const toolCall of message.toolCalls) {
    result.push({
      arguments: toolCall.function.arguments ?? '{}',
      call_id: toolCall.id,
      name: toolCall.function.name,
      type: 'function_call',
    });
  }

  return result;
}

function convertTool(tool: Tool): ResponseToolParam {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  };
}

// ── OpenAIResponsesStreamedMessage ───────────────────────────────────

export class OpenAIResponsesStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(response: unknown, isStream: boolean) {
    if (isStream) {
      this._iter = this._convertStreamResponse(response as AsyncIterable<Record<string, unknown>>);
    } else {
      this._iter = this._convertNonStreamResponse(response as Record<string, unknown>);
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

  private _captureFinishReasonFromResponse(response: Record<string, unknown>): void {
    const status = response['status'] as string | null | undefined;
    const incomplete = response['incomplete_details'] as Record<string, unknown> | undefined;
    const incompleteReason = (incomplete?.['reason'] as string | undefined) ?? null;
    const normalized = normalizeResponsesFinishReason(status, incompleteReason);
    this._finishReason = normalized.finishReason;
    this._rawFinishReason = normalized.rawFinishReason;
  }

  private _extractUsage(usage: Record<string, unknown>): void {
    const inputTokens = typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : 0;
    const outputTokens = typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0;
    let cached = 0;
    const details = usage['input_tokens_details'] as Record<string, unknown> | undefined;
    if (details && typeof details['cached_tokens'] === 'number') {
      cached = details['cached_tokens'];
    }
    this._usage = {
      inputOther: inputTokens - cached,
      output: outputTokens,
      inputCacheRead: cached,
      inputCacheCreation: 0,
    };
  }

  private async *_convertNonStreamResponse(
    response: Record<string, unknown>,
  ): AsyncGenerator<StreamedMessagePart> {
    this._id = (response['id'] as string) ?? null;
    if (response['usage']) {
      this._extractUsage(response['usage'] as Record<string, unknown>);
    }
    this._captureFinishReasonFromResponse(response);

    const output = response['output'] as unknown[];
    if (!output) return;

    for (const item of output) {
      const rec = item as Record<string, unknown>;
      if (rec['type'] === 'message') {
        const content = rec['content'] as unknown[] | undefined;
        for (const c of content ?? []) {
          const contentRec = c as Record<string, unknown>;
          if (contentRec['type'] === 'output_text') {
            yield { type: 'text', text: contentRec['text'] as string };
          }
        }
      } else if (rec['type'] === 'function_call') {
        yield {
          type: 'function',
          id: (rec['call_id'] as string) || crypto.randomUUID(),
          function: {
            name: rec['name'] as string,
            arguments: (rec['arguments'] as string) ?? null,
          },
        } satisfies ToolCall;
      } else if (rec['type'] === 'reasoning') {
        const summary = rec['summary'] as unknown[];
        const encryptedContent = rec['encrypted_content'] as string | undefined;
        for (const s of summary ?? []) {
          const sRec = s as Record<string, unknown>;
          const thinkPart: StreamedMessagePart = {
            type: 'think',
            think: (sRec['text'] as string) ?? '',
          };
          if (encryptedContent !== undefined) {
            (thinkPart as { encrypted: string }).encrypted = encryptedContent;
          }
          yield thinkPart;
        }
      }
    }
  }

  private async *_convertStreamResponse(
    response: AsyncIterable<Record<string, unknown>>,
  ): AsyncGenerator<StreamedMessagePart> {
    try {
      for await (const chunk of response) {
        const chunkType = chunk['type'] as string;

        if (chunkType === 'response.output_text.delta') {
          yield { type: 'text', text: chunk['delta'] as string };
        } else if (chunkType === 'response.created' || chunkType === 'response.in_progress') {
          // Initial events carry the Responses API `response.id`. Record it
          // here so callers that inspect `stream.id` before the stream
          // completes see the actual response id rather than a later
          // output-item identifier.
          const resp = chunk['response'] as Record<string, unknown> | undefined;
          const respId = resp?.['id'];
          if (typeof respId === 'string') {
            this._id = respId;
          }
        } else if (chunkType === 'response.output_item.added') {
          const item = chunk['item'] as Record<string, unknown>;
          // NOTE: `item.id` here is an output-item identifier, not the
          // Responses API `response.id`. Do NOT overwrite `this._id` — it
          // would clobber the real response id (or leave it undefined for
          // tool-call items that have no `item.id`).
          if (item['type'] === 'function_call') {
            // The Responses API routes streaming argument deltas via
            // `item_id`, which matches `item.id` on output_item.added.
            // Preserve it so the generate loop can dispatch interleaved
            // deltas across parallel function calls correctly.
            const itemId = item['id'] as string | undefined;
            const tc: ToolCall = {
              type: 'function',
              id: (item['call_id'] as string) || crypto.randomUUID(),
              function: {
                name: item['name'] as string,
                arguments: (item['arguments'] as string) ?? null,
              },
            };
            if (itemId !== undefined) {
              tc._streamIndex = itemId;
            }
            yield tc;
          }
        } else if (chunkType === 'response.output_item.done') {
          const item = chunk['item'] as Record<string, unknown>;
          // Same as output_item.added: `item.id` is not the response id.
          if (item['type'] === 'reasoning') {
            const encContent = item['encrypted_content'] as string | undefined;
            const thinkPart: StreamedMessagePart = { type: 'think', think: '' };
            if (encContent !== undefined) {
              (thinkPart as { encrypted: string }).encrypted = encContent;
            }
            yield thinkPart;
          }
        } else if (chunkType === 'response.function_call_arguments.delta') {
          // `item_id` uniquely identifies the function_call output item this
          // delta belongs to; use it as the streaming index.
          const itemId = chunk['item_id'] as string | undefined;
          const part: StreamedMessagePart = {
            type: 'tool_call_part',
            argumentsPart: chunk['delta'] as string,
          };
          if (itemId !== undefined) {
            (part as { index: number | string }).index = itemId;
          }
          yield part;
        } else if (chunkType === 'response.reasoning_summary_part.added') {
          yield { type: 'think', think: '' };
        } else if (chunkType === 'response.reasoning_summary_text.delta') {
          yield { type: 'think', think: chunk['delta'] as string };
        } else if (chunkType === 'response.completed' || chunkType === 'response.incomplete') {
          const resp = chunk['response'] as Record<string, unknown>;
          // Final event confirms the Responses API `response.id`. Prefer
          // it over any earlier value in case the API refines it.
          const respId = resp?.['id'];
          if (typeof respId === 'string') {
            this._id = respId;
          }
          if (resp['usage']) {
            this._extractUsage(resp['usage'] as Record<string, unknown>);
          }
          this._captureFinishReasonFromResponse(resp);
        }
      }
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    }
  }
}

// ── OpenAI Responses ChatProvider ────────────────────────────────────

export class OpenAIResponsesChatProvider implements RetryableChatProvider {
  readonly name: string = 'openai-responses';

  private _model: string;
  private _stream: boolean;
  private _apiKey: string | undefined;
  private _baseUrl: string | undefined;
  private _generationKwargs: OpenAIResponsesGenerationKwargs;
  private _toolMessageConversion: ToolMessageConversion;
  private _client: OpenAI;
  private _httpClient: unknown;

  constructor(options: OpenAIResponsesOptions) {
    this._apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'];
    this._baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this._model = options.model;
    this._stream = true; // Responses API always supports streaming
    this._generationKwargs = {};
    this._toolMessageConversion = options.toolMessageConversion ?? null;
    this._httpClient = options.httpClient;

    if (options.maxOutputTokens !== undefined) {
      this._generationKwargs.max_output_tokens = options.maxOutputTokens;
    }

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
    return reasoningEffortToThinkingEffort(this._generationKwargs.reasoning_effort);
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
    if (
      name.startsWith('gpt-4o') ||
      name.startsWith('gpt-4.1') ||
      name.startsWith('gpt-4.5') ||
      name.startsWith('gpt-4-turbo')
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
    return UNKNOWN_CAPABILITY;
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    const input: unknown[] = [];
    if (systemPrompt) {
      const sysItem: Record<string, unknown> = { role: 'system', content: systemPrompt };
      if (isOpenAIModel(this._model)) {
        sysItem['role'] = 'developer';
      }
      input.push(sysItem);
    }

    for (const msg of history) {
      input.push(...convertMessage(msg, this._model, this._toolMessageConversion));
    }

    const kwargs: Record<string, unknown> = { ...this._generationKwargs };
    const reasoningEffort = kwargs['reasoning_effort'] as string | undefined;
    delete kwargs['reasoning_effort'];

    if (reasoningEffort !== undefined) {
      kwargs['reasoning'] = {
        effort: reasoningEffort,
        summary: 'auto',
      };
      kwargs['include'] = ['reasoning.encrypted_content'];
    }

    // Remove undefined values
    for (const key of Object.keys(kwargs)) {
      if (kwargs[key] === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete kwargs[key];
      }
    }

    try {
      const createParams: Record<string, unknown> = {
        model: this._model,
        input,
        tools: tools.map((t) => convertTool(t)),
        store: false,
        stream: this._stream,
        ...kwargs,
      };

      if (
        !('responses' in this._client) ||
        typeof (this._client as { responses?: { create?: unknown } }).responses?.create !==
          'function'
      ) {
        throw new Error(
          'OpenAI SDK version does not support Responses API. Upgrade to >=4.x with responses support.',
        );
      }

      const response = await (
        this._client.responses as {
          create(params: unknown, opts?: unknown): Promise<unknown>;
        }
      ).create(createParams, options?.signal ? { signal: options.signal } : undefined);
      return new OpenAIResponsesStreamedMessage(response, this._stream);
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

  withThinking(effort: ThinkingEffort): OpenAIResponsesChatProvider {
    const reasoningEffort = thinkingEffortToReasoningEffort(effort);
    const clone = this._clone();
    clone._generationKwargs = {
      ...clone._generationKwargs,
      reasoning_effort: reasoningEffort,
    };
    return clone;
  }

  withGenerationKwargs(kwargs: OpenAIResponsesGenerationKwargs): OpenAIResponsesChatProvider {
    const clone = this._clone();
    clone._generationKwargs = { ...clone._generationKwargs, ...kwargs };
    return clone;
  }

  private _clone(): OpenAIResponsesChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as OpenAIResponsesChatProvider,
      this,
    );
    clone._generationKwargs = { ...this._generationKwargs };
    return clone;
  }
}
