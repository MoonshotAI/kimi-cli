import { UNKNOWN_CAPABILITY, type ModelCapability } from './capability.js';
import { ChatProviderError } from './errors.js';
import type {
  AudioURLPart,
  ImageURLPart,
  Message,
  StreamedMessagePart,
  TextPart,
  ThinkPart,
  ToolCall,
  ToolCallPart,
  VideoURLPart,
} from './message.js';
import { extractText } from './message.js';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  StreamedMessage,
  ThinkingEffort,
} from './provider.js';
import { normalizeOpenAIFinishReason } from './providers/openai-common.js';
import type { Tool } from './tool.js';
import type { TokenUsage } from './usage.js';

// ---------------------------------------------------------------------------
// DSL parser
// ---------------------------------------------------------------------------

interface ParseResult {
  parts: StreamedMessagePart[];
  messageId: string | null;
  usage: TokenUsage | null;
  finishReason: FinishReason | null;
  rawFinishReason: string | null;
}

/**
 * Parse an echo DSL script into streamed message parts, an optional id,
 * optional token usage, and an optional finish_reason.
 *
 * The `finish_reason: <raw>` keyword sets the raw finish reason verbatim and
 * normalizes it via {@link normalizeOpenAIFinishReason} (because the echo
 * DSL mimics the OpenAI Chat Completions wire shape). When the keyword is
 * absent the result defaults to `'completed'` / `'stop'` so existing
 * fixtures keep their previous behavior.
 */
export function parseEchoScript(script: string): ParseResult {
  const parts: StreamedMessagePart[] = [];
  let messageId: string | null = null;
  let usage: TokenUsage | null = null;
  let finishReason: FinishReason | null = 'completed';
  let rawFinishReason: string | null = 'stop';

  const lines = script.split('\n');
  for (const [i, rawLine] of lines.entries()) {
    const lineno = i + 1;
    const line = rawLine.trim();

    // skip empty lines, comments, markdown fences, bare "echo" keyword
    if (!line || line.startsWith('#') || line.startsWith('```')) continue;
    if (line.toLowerCase() === 'echo') continue;

    const sepIdx = line.indexOf(':');
    if (sepIdx === -1) {
      throw new ChatProviderError(`Invalid echo DSL at line ${lineno}: ${JSON.stringify(rawLine)}`);
    }

    const kind = line.slice(0, sepIdx).trim().toLowerCase();
    let payload = line.slice(sepIdx + 1);
    // strip at most one leading space from payload
    if (payload.startsWith(' ')) {
      payload = payload.slice(1);
    }

    if (kind === 'id') {
      messageId = stripQuotes(payload.trim());
      continue;
    }
    if (kind === 'usage') {
      usage = parseUsage(payload);
      continue;
    }
    if (kind === 'finish_reason') {
      const rawValue = stripQuotes(payload.trim());
      if (
        rawValue === '' ||
        rawValue.toLowerCase() === 'null' ||
        rawValue.toLowerCase() === 'none'
      ) {
        finishReason = null;
        rawFinishReason = null;
      } else {
        const normalized = normalizeOpenAIFinishReason(rawValue);
        finishReason = normalized.finishReason;
        rawFinishReason = normalized.rawFinishReason;
      }
      continue;
    }

    const part = parsePart(kind, payload, lineno, rawLine);
    parts.push(part);
  }

  return { parts, messageId, usage, finishReason, rawFinishReason };
}

function parsePart(
  kind: string,
  payload: string,
  lineno: number,
  rawLine: string,
): StreamedMessagePart {
  switch (kind) {
    case 'text':
      return { type: 'text', text: stripQuotes(payload) } satisfies TextPart;
    case 'think':
      return { type: 'think', think: stripQuotes(payload) } satisfies ThinkPart;
    case 'think_encrypted':
      return { type: 'think', think: '', encrypted: stripQuotes(payload) } satisfies ThinkPart;
    case 'image_url': {
      const { url, id } = parseUrlPayload(payload, kind);
      const imageUrl: ImageURLPart['imageUrl'] =
        id !== null && id !== undefined ? { url, id } : { url };
      return { type: 'image_url', imageUrl } satisfies ImageURLPart;
    }
    case 'audio_url': {
      const { url, id } = parseUrlPayload(payload, kind);
      const audioUrl: AudioURLPart['audioUrl'] =
        id !== null && id !== undefined ? { url, id } : { url };
      return { type: 'audio_url', audioUrl } satisfies AudioURLPart;
    }
    case 'video_url': {
      const { url, id } = parseUrlPayload(payload, kind);
      const videoUrl: VideoURLPart['videoUrl'] =
        id !== null && id !== undefined ? { url, id } : { url };
      return { type: 'video_url', videoUrl } satisfies VideoURLPart;
    }
    case 'tool_call':
      return parseToolCall(payload, lineno, rawLine);
    case 'tool_call_part':
      return parseToolCallPart(payload);
    default:
      throw new ChatProviderError(
        `Unknown echo DSL kind '${kind}' at line ${lineno}: ${JSON.stringify(rawLine)}`,
      );
  }
}

function parseUsage(payload: string): TokenUsage {
  const mapping = parseMapping(payload, 'usage');

  function intValue(key: string): number {
    const value = mapping[key] ?? 0;
    const n = Number(value);
    if (!Number.isInteger(n)) {
      throw new ChatProviderError(
        `Usage field '${key}' must be an integer, got ${JSON.stringify(value)}`,
      );
    }
    return n;
  }

  return {
    inputOther: intValue('input_other'),
    output: intValue('output'),
    inputCacheRead: intValue('input_cache_read'),
    inputCacheCreation: intValue('input_cache_creation'),
  };
}

function parseUrlPayload(payload: string, kind: string): { url: string; id: string | null } {
  const value = parseValue(payload);
  if (typeof value === 'object' && value !== null && value !== undefined && !Array.isArray(value)) {
    const mapping = value as Record<string, unknown>;
    const url = mapping['url'];
    if (typeof url !== 'string') {
      throw new ChatProviderError(`${kind} requires a url field, got ${JSON.stringify(mapping)}`);
    }
    const contentId = mapping['id'];
    if (contentId !== null && contentId !== undefined && typeof contentId !== 'string') {
      throw new ChatProviderError(`${kind} id must be a string when provided.`);
    }
    return { url, id: (contentId as string | undefined) ?? null };
  }
  if (typeof value !== 'string') {
    throw new ChatProviderError(
      `${kind} expects url string or object, got ${JSON.stringify(value)}`,
    );
  }
  return { url: value, id: null };
}

function parseToolCall(payload: string, lineno: number, rawLine: string): ToolCall {
  const mapping = parseMapping(payload, 'tool_call');
  const func =
    typeof mapping['function'] === 'object' &&
    mapping['function'] !== null &&
    mapping['function'] !== undefined
      ? (mapping['function'] as Record<string, unknown>)
      : null;

  const toolCallId = mapping['id'] as string | undefined;
  let name = (mapping['name'] as string | undefined) ?? (func?.['name'] as string | undefined);
  let args = mapping['arguments'] as string | null | undefined;

  if (func) {
    args ??= func['arguments'] as string | null | undefined;
  }

  if (typeof toolCallId !== 'string' || typeof name !== 'string') {
    throw new ChatProviderError(
      `tool_call requires string id and name at line ${lineno}: ${JSON.stringify(rawLine)}`,
    );
  }

  if (args !== null && args !== undefined && typeof args !== 'string') {
    throw new ChatProviderError(
      `tool_call.arguments must be a string at line ${lineno}, got ${typeof args}`,
    );
  }

  return {
    type: 'function',
    id: toolCallId,
    function: { name, arguments: args ?? null },
  };
}

function parseToolCallPart(payload: string): ToolCallPart {
  const value = parseValue(payload);
  let argumentsPart: unknown;

  if (typeof value === 'object' && value !== null && value !== undefined && !Array.isArray(value)) {
    argumentsPart = (value as Record<string, unknown>)['arguments_part'];
  } else {
    argumentsPart = value;
  }

  if (typeof argumentsPart === 'object' && argumentsPart !== null && argumentsPart !== undefined) {
    argumentsPart = JSON.stringify(argumentsPart);
  }

  const result =
    argumentsPart === null || argumentsPart === undefined || argumentsPart === ''
      ? null
      : argumentsPart;
  return { type: 'tool_call_part', argumentsPart: result as string | null };
}

function parseMapping(raw: string, context: string): Record<string, unknown> {
  raw = raw.trim();

  // Try JSON first
  try {
    const loaded: unknown = JSON.parse(raw);
    if (
      typeof loaded === 'object' &&
      loaded !== null &&
      loaded !== undefined &&
      !Array.isArray(loaded)
    ) {
      return loaded as Record<string, unknown>;
    }
    if (loaded !== null && loaded !== undefined) {
      throw new ChatProviderError(
        `${context} payload must be an object, got ${JSON.stringify(loaded)}`,
      );
    }
  } catch (error) {
    if (error instanceof ChatProviderError) throw error;
    // not valid JSON — fall through to key=value parsing
  }

  // key=value parsing
  const mapping: Record<string, unknown> = {};
  const tokens = raw.replaceAll(',', ' ').split(/\s+/);
  for (const token of tokens) {
    if (!token) continue;
    if (!token.includes('=')) {
      throw new ChatProviderError(`Invalid token '${token}' in ${context} payload.`);
    }
    const eqIdx = token.indexOf('=');
    const key = token.slice(0, eqIdx).trim();
    const val = token.slice(eqIdx + 1).trim();
    mapping[key] = parseValue(val);
  }

  if (Object.keys(mapping).length === 0) {
    throw new ChatProviderError(`${context} payload cannot be empty.`);
  }
  return mapping;
}

function parseValue(raw: string): unknown {
  raw = raw.trim();
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (lowered === 'null' || lowered === 'none') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return stripQuotes(raw);
  }
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === "'" || value[0] === '"')) {
    return value.slice(1, -1);
  }
  return value;
}

// ---------------------------------------------------------------------------
// EchoStreamedMessage
// ---------------------------------------------------------------------------

class EchoStreamedMessage implements StreamedMessage {
  readonly id: string | null;
  readonly usage: TokenUsage | null;
  readonly finishReason: FinishReason | null;
  readonly rawFinishReason: string | null;

  private readonly _parts: StreamedMessagePart[];

  constructor(
    parts: StreamedMessagePart[],
    id: string | null,
    usage: TokenUsage | null,
    finishReason: FinishReason | null,
    rawFinishReason: string | null,
  ) {
    this._parts = parts;
    this.id = id;
    this.usage = usage;
    this.finishReason = finishReason;
    this.rawFinishReason = rawFinishReason;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    for (const part of this._parts) {
      yield part;
    }
  }
}

// ---------------------------------------------------------------------------
// EchoChatProvider
// ---------------------------------------------------------------------------

/**
 * A test-only chat provider that streams parts described by a tiny DSL.
 *
 * The DSL lives in the text content of the last message in `history`.
 */
export class EchoChatProvider implements ChatProvider {
  readonly name: string = 'echo';
  readonly modelName: string = 'echo';
  readonly thinkingEffort: ThinkingEffort | null = null;

  async generate(
    _systemPrompt: string,
    _tools: Tool[],
    history: Message[],
    _options?: GenerateOptions,
  ): Promise<EchoStreamedMessage> {
    const lastMessage = history.at(-1);
    if (lastMessage === undefined) {
      throw new ChatProviderError('EchoChatProvider requires at least one message in history.');
    }
    if (lastMessage.role !== 'user') {
      throw new ChatProviderError('EchoChatProvider expects the last history message to be user.');
    }

    const scriptText = extractText(lastMessage);
    const { parts, messageId, usage, finishReason, rawFinishReason } = parseEchoScript(scriptText);
    if (parts.length === 0) {
      throw new ChatProviderError('EchoChatProvider DSL produced no streamable parts.');
    }
    return new EchoStreamedMessage(parts, messageId, usage, finishReason, rawFinishReason);
  }

  withThinking(_effort: ThinkingEffort): EchoChatProvider {
    return new EchoChatProvider();
  }

  getCapability(_model?: string): ModelCapability {
    return UNKNOWN_CAPABILITY;
  }
}

// ---------------------------------------------------------------------------
// ScriptedEchoChatProvider
// ---------------------------------------------------------------------------

/**
 * A test-only chat provider that consumes a queue of echo DSL scripts
 * per call, one per `generate()` invocation.
 */
export class ScriptedEchoChatProvider implements ChatProvider {
  readonly name: string = 'scripted_echo';
  readonly modelName: string = 'scripted_echo';
  readonly thinkingEffort: ThinkingEffort | null = null;

  private readonly _scripts: string[];
  private _cursor: number = 0;

  constructor(scripts: string[]) {
    this._scripts = [...scripts];
  }

  async generate(
    _systemPrompt: string,
    _tools: Tool[],
    _history: Message[],
    _options?: GenerateOptions,
  ): Promise<EchoStreamedMessage> {
    const scriptText = this._scripts[this._cursor];
    if (scriptText === undefined) {
      throw new ChatProviderError(
        `ScriptedEchoChatProvider exhausted at turn ${this._cursor + 1}.`,
      );
    }
    this._cursor++;

    const { parts, messageId, usage, finishReason, rawFinishReason } = parseEchoScript(scriptText);
    if (parts.length === 0) {
      throw new ChatProviderError('ScriptedEchoChatProvider DSL produced no streamable parts.');
    }
    return new EchoStreamedMessage(parts, messageId, usage, finishReason, rawFinishReason);
  }

  withThinking(_effort: ThinkingEffort): ScriptedEchoChatProvider {
    return new ScriptedEchoChatProvider(this._scripts.slice(this._cursor));
  }

  getCapability(_model?: string): ModelCapability {
    return UNKNOWN_CAPABILITY;
  }
}
