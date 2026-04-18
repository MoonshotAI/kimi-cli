import { ApiError as GoogleApiError, GoogleGenAI as GenAIClient } from '@google/genai';

import { UNKNOWN_CAPABILITY, type ModelCapability } from '../capability.js';
import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
} from '../errors.js';
import type { Message, StreamedMessagePart, ToolCall } from '../message.js';
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
 * Normalize a Google GenAI (Gemini) `finishReason` value to the unified
 * {@link FinishReason} enum.
 *
 * Source: `candidates[0].finishReason` (works for both stream and
 * non-stream — the SDK normalizes them). Gemini does not emit a
 * `tool_calls`-style reason; tool calls come via `parts[].functionCall`
 * and `finishReason` stays `'completed'` even when the model produces
 * function calls.
 */
function normalizeGoogleGenAIFinishReason(raw: unknown): {
  finishReason: FinishReason | null;
  rawFinishReason: string | null;
} {
  if (raw === null || raw === undefined) {
    return { finishReason: null, rawFinishReason: null };
  }
  // The SDK normally hands us a plain string but older builds wrap it in
  // an enum-like object. Accept both shapes and uppercase to match the
  // documented constants. Anything else collapses to "no signal" so we
  // never emit a junk `[object Object]` raw value.
  let rawString: string;
  if (typeof raw === 'string') {
    rawString = raw.toUpperCase();
  } else if (typeof raw === 'number' || typeof raw === 'bigint' || typeof raw === 'boolean') {
    rawString = String(raw).toUpperCase();
  } else {
    return { finishReason: null, rawFinishReason: null };
  }
  if (rawString === 'FINISH_REASON_UNSPECIFIED' || rawString === '') {
    return { finishReason: null, rawFinishReason: null };
  }
  switch (rawString) {
    case 'STOP':
      return { finishReason: 'completed', rawFinishReason: rawString };
    case 'MAX_TOKENS':
      return { finishReason: 'truncated', rawFinishReason: rawString };
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return { finishReason: 'filtered', rawFinishReason: rawString };
    case 'MALFORMED_FUNCTION_CALL':
    case 'OTHER':
    case 'LANGUAGE':
      return { finishReason: 'other', rawFinishReason: rawString };
    default:
      return { finishReason: 'other', rawFinishReason: rawString };
  }
}

// ── Types ─────────────────────────────────────────────────────────────

export interface GoogleGenAIOptions {
  apiKey?: string | undefined;
  model: string;
  vertexai?: boolean | undefined;
  project?: string | undefined;
  location?: string | undefined;
  stream?: boolean | undefined;
}

export interface GoogleGenAIGenerationKwargs {
  max_output_tokens?: number | undefined;
  temperature?: number | undefined;
  top_k?: number | undefined;
  top_p?: number | undefined;
  thinking_config?: ThinkingConfig | undefined;
  [key: string]: unknown;
}

interface ThinkingConfig {
  include_thoughts?: boolean;
  thinking_budget?: number;
  thinking_level?: string;
}

// ── Tool conversion ─────────────────────────────────────────────────

interface GoogleFunctionDeclaration {
  name: string;
  description: string;
  parameters_json_schema: Record<string, unknown>;
}

interface GoogleTool {
  function_declarations: GoogleFunctionDeclaration[];
}

function toolToGoogleGenAI(tool: Tool): GoogleTool {
  return {
    function_declarations: [
      {
        name: tool.name,
        description: tool.description,
        parameters_json_schema: tool.parameters,
      },
    ],
  };
}

// ── Message conversion ──────────────────────────────────────────────

interface GoogleContent {
  role: string;
  parts: GooglePart[];
}

interface GooglePart {
  text?: string;
  function_call?: { name: string; args: Record<string, unknown> };
  function_response?: {
    name: string;
    response: Record<string, string>;
    parts: unknown[];
  };
  thought_signature?: string;
  [key: string]: unknown;
}

function toolCallIdToName(toolCallId: string, toolNameById: Map<string, string>): string {
  const name = toolNameById.get(toolCallId);
  if (name !== undefined) return name;
  // Fallback: ids produced by this provider follow the format
  // "{tool_name}_{id_suffix}" where `tool_name` may itself contain
  // underscores (e.g. `fetch_image`) and `id_suffix` is a single trailing
  // token without underscores (e.g. a random hex / UUID fragment). We strip
  // the last "_<suffix>" segment by matching it explicitly — splitting on
  // the first underscore would truncate multi-word tool names like
  // `fetch_image_<id>` to just `fetch`.
  const match = /^(.+)_[^_]+$/.exec(toolCallId);
  return match?.[1] ?? toolCallId;
}

/**
 * Convert a data URL or HTTP URL to a Google GenAI inline/file data part.
 * - data: URLs are parsed into { inlineData: { mimeType, data } }
 * - http(s): URLs use { fileData: { fileUri, mimeType } }
 */
function convertMediaUrl(
  url: string,
  fallbackMimeType: string,
):
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { fileUri: string; mimeType: string } } {
  if (url.startsWith('data:')) {
    const commaIndex = url.indexOf(',');
    if (commaIndex === -1) {
      return { fileData: { fileUri: url, mimeType: fallbackMimeType } };
    }
    const meta = url.slice(0, commaIndex);
    const data = url.slice(commaIndex + 1);
    const colonIndex = meta.indexOf(':');
    const semiIndex = meta.indexOf(';');
    const mimeType =
      colonIndex !== -1 && semiIndex !== -1
        ? meta.slice(colonIndex + 1, semiIndex)
        : fallbackMimeType;
    return { inlineData: { mimeType, data } };
  }
  // For HTTP(S) URLs, try to guess mime type from extension
  let mimeType = fallbackMimeType;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith('.png')) mimeType = 'image/png';
    else if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) mimeType = 'image/jpeg';
    else if (pathname.endsWith('.gif')) mimeType = 'image/gif';
    else if (pathname.endsWith('.webp')) mimeType = 'image/webp';
    else if (pathname.endsWith('.mp3') || pathname.endsWith('.mpeg')) mimeType = 'audio/mpeg';
    else if (pathname.endsWith('.wav')) mimeType = 'audio/wav';
    else if (pathname.endsWith('.ogg')) mimeType = 'audio/ogg';
  } catch {
    // URL parsing failed, use fallback
  }
  return { fileData: { fileUri: url, mimeType } };
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

async function abortPromise(signal: AbortSignal | undefined): Promise<never> {
  if (signal === undefined) {
    return new Promise(() => {
      // Intentionally never settles when no signal is provided.
    });
  }
  if (signal.aborted) {
    throw createAbortError();
  }
  return new Promise((_, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(createAbortError());
      },
      { once: true },
    );
  });
}

function messageToGoogleGenAI(message: Message): GoogleContent {
  if (message.role === 'tool') {
    throw new ChatProviderError(
      'Tool messages must be converted via messagesToGoogleGenAIContents.',
    );
  }

  // GoogleGenAI uses "model" instead of "assistant"
  const role = message.role === 'assistant' ? 'model' : message.role;
  const parts: GooglePart[] = [];

  // Handle content parts
  for (const part of message.content) {
    switch (part.type) {
      case 'text':
        parts.push({ text: part.text });
        break;
      case 'think':
        // Skip think parts (synthetic)
        break;
      case 'image_url':
        parts.push(convertMediaUrl(part.imageUrl.url, 'image/jpeg'));
        break;
      case 'audio_url':
        parts.push(convertMediaUrl(part.audioUrl.url, 'audio/mpeg'));
        break;
      case 'video_url':
        parts.push(convertMediaUrl(part.videoUrl.url, 'video/mp4'));
        break;
    }
  }

  // Handle tool calls
  for (const toolCall of message.toolCalls) {
    let args: Record<string, unknown> = {};
    if (toolCall.function.arguments) {
      try {
        const parsed: unknown = JSON.parse(toolCall.function.arguments);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        } else {
          throw new ChatProviderError('Tool call arguments must be a JSON object.');
        }
      } catch (error) {
        if (error instanceof ChatProviderError) throw error;
        throw new ChatProviderError('Tool call arguments must be valid JSON.');
      }
    }

    const functionCallPart: GooglePart = {
      function_call: {
        name: toolCall.function.name,
        args,
      },
    };

    // Restore thought_signature if available
    if (toolCall.extras && 'thought_signature_b64' in toolCall.extras) {
      functionCallPart['thought_signature'] = toolCall.extras['thought_signature_b64'] as string;
    }

    parts.push(functionCallPart);
  }

  return { role, parts };
}

/**
 * Convert a tool message into a list of Google GenAI parts.
 *
 * Returns a `functionResponse` part carrying the text output, followed by
 * independent media parts (`inlineData` / `fileData`) for any image/audio/video
 * content in the tool result. This preserves multimodal tool outputs so the
 * next Gemini/Vertex turn can see them — returning only the text would silently
 * drop media and break tool chains that rely on images or audio.
 */
function toolMessageToFunctionResponseParts(
  message: Message,
  toolNameById: Map<string, string>,
): GooglePart[] {
  if (message.role !== 'tool') {
    throw new ChatProviderError('Expected a tool message.');
  }
  if (message.toolCallId === undefined) {
    throw new ChatProviderError('Tool response is missing `toolCallId`.');
  }

  // Separate text output from media parts
  let textOutput = '';
  const mediaParts: GooglePart[] = [];
  for (const part of message.content) {
    switch (part.type) {
      case 'text':
        if (part.text) textOutput += part.text;
        break;
      case 'image_url':
        mediaParts.push(convertMediaUrl(part.imageUrl.url, 'image/jpeg'));
        break;
      case 'audio_url':
        mediaParts.push(convertMediaUrl(part.audioUrl.url, 'audio/mpeg'));
        break;
      case 'video_url':
        mediaParts.push(convertMediaUrl(part.videoUrl.url, 'video/mp4'));
        break;
      case 'think':
        // Skip — handled separately via reasoning channel.
        break;
    }
  }

  const functionResponsePart: GooglePart = {
    function_response: {
      name: toolCallIdToName(message.toolCallId, toolNameById),
      response: { output: textOutput },
      parts: [],
    },
  };

  return [functionResponsePart, ...mediaParts];
}

export function messagesToGoogleGenAIContents(messages: Message[]): GoogleContent[] {
  const contents: GoogleContent[] = [];
  const toolNameById = new Map<string, string>();

  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (message === undefined) break;

    if (message.role === 'system') {
      // Google GenAI's `Content.role` only accepts "user" or "model", so a
      // system message in the history (e.g. from session restore or
      // cross-provider migration) would be rejected by the API. Preserve
      // the content by wrapping it in a `<system>` tag and attaching it as
      // a user turn — mirrors the Anthropic provider's behavior. The
      // dedicated top-level `systemPrompt` still flows into
      // `system_instruction` separately; only historical system messages
      // come through here.
      const text = message.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      if (text.length > 0) {
        contents.push({
          role: 'user',
          parts: [{ text: `<system>${text}</system>` }],
        });
      }
      i += 1;
      continue;
    }

    if (message.role === 'assistant' && message.toolCalls.length > 0) {
      contents.push(messageToGoogleGenAI(message));
      const expectedToolCallIds: string[] = [];
      for (const toolCall of message.toolCalls) {
        toolNameById.set(toolCall.id, toolCall.function.name);
        expectedToolCallIds.push(toolCall.id);
      }

      // Collect consecutive tool messages
      let j = i + 1;
      const toolMessages: Message[] = [];
      while (j < messages.length) {
        const toolMsg = messages[j];
        if (toolMsg === undefined || toolMsg.role !== 'tool') break;
        toolMessages.push(toolMsg);
        j += 1;
      }

      if (toolMessages.length > 0) {
        // Sort tool results to match the order of tool calls in the assistant
        // message, and reject incomplete / duplicated / unexpected results.
        // Gemini/Vertex expects the next user turn to contain a matching set of
        // function responses for the preceding function calls.
        const toolMsgById = new Map<string, Message>();
        const seenToolCallIds = new Set<string>();
        for (const toolMsg of toolMessages) {
          if (toolMsg.toolCallId === undefined) {
            throw new ChatProviderError('Tool response is missing `toolCallId`.');
          }
          if (seenToolCallIds.has(toolMsg.toolCallId)) {
            throw new ChatProviderError(`Duplicate tool response for id: ${toolMsg.toolCallId}`);
          }
          seenToolCallIds.add(toolMsg.toolCallId);
          toolMsgById.set(toolMsg.toolCallId, toolMsg);
        }

        const sortedToolMessages: Message[] = [];
        for (const expectedId of expectedToolCallIds) {
          const msg = toolMsgById.get(expectedId);
          if (msg === undefined) {
            throw new ChatProviderError(`Missing tool responses for ids: ${expectedId}`);
          }
          sortedToolMessages.push(msg);
          toolMsgById.delete(expectedId);
        }
        if (toolMsgById.size > 0) {
          throw new ChatProviderError(
            `Unexpected tool responses for ids: ${JSON.stringify([...toolMsgById.keys()])}`,
          );
        }

        // Pack all tool results into a single user Content.
        // Each tool result may expand to multiple parts (functionResponse +
        // media parts for image/audio/video outputs).
        const parts: GooglePart[] = [];
        for (const toolMsg of sortedToolMessages) {
          parts.push(...toolMessageToFunctionResponseParts(toolMsg, toolNameById));
        }
        contents.push({ role: 'user', parts });
        i = j;
        continue;
      }

      i += 1;
      continue;
    }

    if (message.role === 'tool') {
      // Tool message without preceding assistant message
      const parts: GooglePart[] = toolMessageToFunctionResponseParts(message, toolNameById);
      contents.push({ role: 'user', parts });
      i += 1;
      continue;
    }

    contents.push(messageToGoogleGenAI(message));
    i += 1;
  }

  return contents;
}

// ── GoogleGenAIStreamedMessage ──────────────────────────────────────

export class GoogleGenAIStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(
    response: AsyncIterable<Record<string, unknown>> | Record<string, unknown>,
    isStream: boolean,
    signal?: AbortSignal,
  ) {
    if (isStream) {
      this._iter = this._convertStreamResponse(
        response as AsyncIterable<Record<string, unknown>>,
        signal,
      );
    } else {
      this._iter = this._convertNonStreamResponse(response as Record<string, unknown>, signal);
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

  private _captureFinishReason(response: Record<string, unknown>): void {
    const candidates = response['candidates'] as unknown[] | undefined;
    if (!candidates || candidates.length === 0) {
      return;
    }
    const first = candidates[0] as Record<string, unknown> | undefined;
    if (first === undefined) {
      return;
    }
    const raw = first['finishReason'] ?? first['finish_reason'];
    if (raw === undefined) {
      return;
    }
    const normalized = normalizeGoogleGenAIFinishReason(raw);
    // Only overwrite when we got a definitive signal — early stream
    // chunks may contain `FINISH_REASON_UNSPECIFIED` while the model is
    // still generating, and we treat those as "not yet known".
    if (normalized.finishReason !== null || normalized.rawFinishReason !== null) {
      this._finishReason = normalized.finishReason;
      this._rawFinishReason = normalized.rawFinishReason;
    }
  }

  /** Yield parts from a single (non-streamed) GenerateContentResponse. */
  private _extractChunkParts(response: Record<string, unknown>): StreamedMessagePart[] {
    const parts: StreamedMessagePart[] = [];

    const candidates = response['candidates'] as unknown[] | undefined;
    for (const candidate of candidates ?? []) {
      const cand = candidate as Record<string, unknown>;
      const content = cand['content'] as Record<string, unknown> | undefined;
      const contentParts = content?.['parts'] as unknown[] | undefined;
      if (!contentParts) continue;

      for (const part of contentParts) {
        const p = part as Record<string, unknown>;
        if (p['thought'] === true && p['text']) {
          parts.push({ type: 'think', think: p['text'] as string });
        } else if (p['text']) {
          parts.push({ type: 'text', text: p['text'] as string });
        } else if (p['functionCall'] || p['function_call']) {
          const fc = (p['functionCall'] ?? p['function_call']) as Record<string, unknown>;
          const name = fc['name'] as string;
          if (!name) continue;
          const id_ = (fc['id'] as string) ?? crypto.randomUUID();
          const toolCallId = `${name}_${id_}`;
          const thoughtSigB64 = p['thoughtSignature'] ?? p['thought_signature'];
          parts.push({
            type: 'function',
            id: toolCallId,
            function: {
              name,
              arguments: fc['args'] ? JSON.stringify(fc['args']) : '{}',
            },
            ...(thoughtSigB64
              ? { extras: { thought_signature_b64: thoughtSigB64 as string } }
              : {}),
          } satisfies ToolCall);
        }
      }
    }

    return parts;
  }

  /** Extract usage metadata from a response chunk. */
  private _extractUsage(response: Record<string, unknown>): void {
    const usageMetadata = response['usageMetadata'] as Record<string, unknown> | undefined;
    if (usageMetadata) {
      this._usage = {
        inputOther: (usageMetadata['promptTokenCount'] as number) ?? 0,
        output: (usageMetadata['candidatesTokenCount'] as number) ?? 0,
        inputCacheRead: (usageMetadata['cachedContentTokenCount'] as number) ?? 0,
        inputCacheCreation: 0,
      };
    }
  }

  /** Extract response ID from a response chunk. */
  private _extractId(response: Record<string, unknown>): void {
    if (response['responseId'] !== undefined) {
      this._id = response['responseId'] as string;
    }
  }

  private _throwIfAborted(signal: AbortSignal | undefined): void {
    // Helper kept small so TypeScript's control-flow narrowing does not
    // collapse `signal.aborted` to `false | undefined` at call sites that
    // check the signal repeatedly between async steps.
    if (signal !== undefined && signal.aborted) {
      throw createAbortError();
    }
  }

  private async *_convertNonStreamResponse(
    response: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamedMessagePart> {
    this._throwIfAborted(signal);
    this._extractUsage(response);
    this._extractId(response);
    this._captureFinishReason(response);
    for (const part of this._extractChunkParts(response)) {
      this._throwIfAborted(signal);
      yield part;
    }
  }

  private async *_convertStreamResponse(
    response: AsyncIterable<Record<string, unknown>>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamedMessagePart> {
    try {
      for await (const chunk of response) {
        // Check abort at each chunk boundary so users who pass an
        // AbortSignal see cancellation honored promptly even though the
        // Google GenAI SDK does not forward it to the underlying fetch.
        this._throwIfAborted(signal);
        this._extractUsage(chunk);
        this._extractId(chunk);
        this._captureFinishReason(chunk);
        for (const part of this._extractChunkParts(chunk)) {
          this._throwIfAborted(signal);
          yield part;
        }
      }
    } catch (error: unknown) {
      // Preserve AbortError identity so the retry/generate loop can
      // distinguish it from transient provider errors.
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      throw convertGoogleGenAIError(error);
    }
  }
}

// ── Error conversion ────────────────────────────────────────────────

const NETWORK_RE = /network|connection|connect|disconnect|fetch failed/i;
const TIMEOUT_RE = /timed?\s*out|timeout|deadline/i;

/**
 * Convert a Google GenAI SDK error (or raw Error) to a kosong `ChatProviderError`.
 */
export function convertGoogleGenAIError(error: unknown): ChatProviderError {
  // Google SDK's exported ApiError carries an HTTP status code
  if (error instanceof GoogleApiError) {
    return new APIStatusError(error.status, error.message);
  }
  if (error instanceof Error) {
    const msg = error.message;
    // Timeout takes priority over network (a timeout is also a connection issue)
    if (TIMEOUT_RE.test(msg)) {
      return new APITimeoutError(msg);
    }
    // Network / fetch errors (e.g. TypeError: fetch failed)
    if (NETWORK_RE.test(msg) || (error instanceof TypeError && msg.includes('fetch'))) {
      return new APIConnectionError(msg);
    }
    // Try to extract status code from unknown error shapes
    const statusCode = (error as { code?: number }).code;
    if (typeof statusCode === 'number') {
      return new APIStatusError(statusCode, msg);
    }
    return new ChatProviderError(`GoogleGenAI error: ${msg}`);
  }
  return new ChatProviderError(`GoogleGenAI error: ${String(error)}`);
}

// ── Google GenAI ChatProvider ───────────────────────────────────────

export class GoogleGenAIChatProvider implements RetryableChatProvider {
  readonly name: string = 'google_genai';

  private _model: string;
  private _client: GenAIClient;
  private _generationKwargs: GoogleGenAIGenerationKwargs;
  private _vertexai: boolean;
  private _stream: boolean;
  // Stored so onRetryableError can rebuild a fresh client after a transient
  // failure without re-asking the caller for credentials / project info.
  private _apiKey: string;
  private _project: string | undefined;
  private _location: string | undefined;

  constructor(options: GoogleGenAIOptions) {
    this._model = options.model;
    this._vertexai = options.vertexai ?? false;
    this._stream = options.stream ?? true;
    this._generationKwargs = {};

    this._apiKey = options.apiKey ?? process.env['GOOGLE_API_KEY'] ?? '';
    this._project = options.project;
    this._location = options.location;
    this._client = this._buildClient();
  }

  private _buildClient(): GenAIClient {
    return new GenAIClient({
      apiKey: this._apiKey,
      ...(this._vertexai
        ? {
            vertexai: true,
            ...(this._project !== undefined ? { project: this._project } : {}),
            ...(this._location !== undefined ? { location: this._location } : {}),
          }
        : {}),
    });
  }

  /**
   * Rebuild the Google GenAI client to recover from transient connection /
   * stream errors. Called by the retry loop before a retry attempt.
   *
   * The `@google/genai` SDK uses Node.js built-in `fetch` and has no explicit
   * `close()` hook, so swapping the instance is sufficient to drop any
   * lingering streaming state. If a future SDK version exposes a close hook,
   * call it here before replacing `_client`.
   */
  onRetryableError(_error: Error): boolean {
    this._client = this._buildClient();
    return true;
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    const thinkingConfig = this._generationKwargs.thinking_config;
    if (thinkingConfig === undefined) return null;

    // For gemini-3 models that use thinking_level
    if (thinkingConfig.thinking_level !== undefined) {
      switch (thinkingConfig.thinking_level) {
        case 'MINIMAL':
          // MINIMAL + suppressed thoughts is how 'off' is encoded for Gemini 3,
          // which has no true "disabled" level.
          return thinkingConfig.include_thoughts === false ? 'off' : 'low';
        case 'LOW':
          return 'low';
        case 'MEDIUM':
          return 'medium';
        case 'HIGH':
          return 'high';
        default:
          return null;
      }
    }

    // For other models that use thinking_budget
    if (thinkingConfig.thinking_budget !== undefined) {
      if (thinkingConfig.thinking_budget === 0) return 'off';
      if (thinkingConfig.thinking_budget <= 1024) return 'low';
      if (thinkingConfig.thinking_budget <= 4096) return 'medium';
      return 'high';
    }

    return null;
  }

  get modelParameters(): Record<string, unknown> {
    return {
      model: this._model,
      ...this._generationKwargs,
    };
  }

  getCapability(model?: string): ModelCapability {
    const name = (model ?? this._model).toLowerCase();
    if (!name.startsWith('gemini-')) return UNKNOWN_CAPABILITY;
    // Known Gemini catalogue. 1.5 / 2.0 / 2.5 families are multimodal
    // (image/video/audio) and support tool use. Unknown gemini-* models
    // stay UNKNOWN_CAPABILITY so the matrix never overpromises.
    const catalogued =
      name.startsWith('gemini-1.5-pro') ||
      name.startsWith('gemini-1.5-flash') ||
      name.startsWith('gemini-2.0-flash') ||
      name.startsWith('gemini-2.0-pro') ||
      name.startsWith('gemini-2.5-pro') ||
      name.startsWith('gemini-2.5-flash');
    if (!catalogued) return UNKNOWN_CAPABILITY;
    // Gemini 2.5 family (pro / flash) ships with native thinking;
    // `gemini-*-thinking` variants also explicitly opt-in. Pre-2.5
    // models do not expose thinking.
    const thinking =
      name.startsWith('gemini-2.5-') || name.includes('thinking');
    return {
      image_in: true,
      video_in: true,
      audio_in: true,
      thinking,
      tool_use: true,
      max_context_tokens: 0,
    };
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    // Short-circuit if the caller has already aborted — the Google GenAI
    // SDK will not honor the signal natively, so we must check manually.
    if (options?.signal?.aborted === true) {
      throw createAbortError();
    }

    const contents = messagesToGoogleGenAIContents(history);

    const config: Record<string, unknown> = {
      ...this._generationKwargs,
      system_instruction: systemPrompt,
      ...(tools.length > 0 ? { tools: tools.map((t) => toolToGoogleGenAI(t)) } : {}),
    };

    try {
      const models = this._client.models as unknown as {
        generateContent(params: Record<string, unknown>): Promise<unknown>;
        generateContentStream(params: Record<string, unknown>): Promise<AsyncGenerator>;
      };

      const params = { model: this._model, contents, config };

      // The Google GenAI SDK does not accept an AbortSignal, so we must race
      // the initial SDK request against the caller's abort signal ourselves.
      // Once we have a response/stream object, the wrapper below continues to
      // check the signal at each chunk boundary.
      if (this._stream) {
        const stream = await Promise.race([
          models.generateContentStream(params),
          abortPromise(options?.signal),
        ]);
        return new GoogleGenAIStreamedMessage(
          stream as AsyncIterable<Record<string, unknown>>,
          true,
          options?.signal,
        );
      }

      const response = await Promise.race([
        models.generateContent(params),
        abortPromise(options?.signal),
      ]);
      return new GoogleGenAIStreamedMessage(
        response as Record<string, unknown>,
        false,
        options?.signal,
      );
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      throw convertGoogleGenAIError(error);
    }
  }

  withThinking(effort: ThinkingEffort): GoogleGenAIChatProvider {
    const thinkingConfig: ThinkingConfig = { include_thoughts: true };

    if (this._model.includes('gemini-3')) {
      // Gemini 3 models use thinking_level (MINIMAL/LOW/MEDIUM/HIGH). The SDK
      // does not expose a "disabled" level, so 'off' maps to MINIMAL with
      // thought output suppressed — the lowest thinking intensity available.
      switch (effort) {
        case 'off':
          thinkingConfig.thinking_level = 'MINIMAL';
          thinkingConfig.include_thoughts = false;
          break;
        case 'low':
          thinkingConfig.thinking_level = 'LOW';
          break;
        case 'medium':
          thinkingConfig.thinking_level = 'MEDIUM';
          break;
        case 'high':
          thinkingConfig.thinking_level = 'HIGH';
          break;
      }
    } else {
      switch (effort) {
        case 'off':
          thinkingConfig.thinking_budget = 0;
          thinkingConfig.include_thoughts = false;
          break;
        case 'low':
          thinkingConfig.thinking_budget = 1024;
          thinkingConfig.include_thoughts = true;
          break;
        case 'medium':
          thinkingConfig.thinking_budget = 4096;
          thinkingConfig.include_thoughts = true;
          break;
        case 'high':
          thinkingConfig.thinking_budget = 32_000;
          thinkingConfig.include_thoughts = true;
          break;
      }
    }

    return this.withGenerationKwargs({ thinking_config: thinkingConfig });
  }

  withGenerationKwargs(kwargs: GoogleGenAIGenerationKwargs): GoogleGenAIChatProvider {
    const clone = this._clone();
    clone._generationKwargs = { ...clone._generationKwargs, ...kwargs };
    return clone;
  }

  private _clone(): GoogleGenAIChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as GoogleGenAIChatProvider,
      this,
    );
    clone._generationKwargs = { ...this._generationKwargs };
    return clone;
  }
}
