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
import { ContextOverflowError } from '../soul/errors.js';
import { ProviderError } from './errors.js';

export interface TokenRefresher {
  refresh(): Promise<void>;
}

export interface KosongAdapterOptions {
  readonly provider: ChatProvider;
  /**
   * Slice 7.4 / 决策 #94 — OAuth token refresher. When provided, a 401
   * response from the provider triggers a single `refresh()` + chat retry.
   * Refresh failure or a second 401 ends the loop with the original error.
   */
  readonly tokenRefresher?: TokenRefresher | undefined;
  /** Maximum retries for transient (network / 5xx / 429) errors. Default 3. */
  readonly maxRetries?: number | undefined;
  /** Base delay for exponential backoff. Default 1000 ms. */
  readonly baseRetryDelayMs?: number | undefined;
}

export class KosongAdapter implements KosongAdapterInterface {
  private readonly provider: ChatProvider;
  private readonly tokenRefresher: TokenRefresher | undefined;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;

  constructor(options: KosongAdapterOptions) {
    this.provider = options.provider;
    this.tokenRefresher = options.tokenRefresher;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1000;
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    // Pre-flight abort check so callers that abort before invoking the
    // adapter get an immediate rejection without touching the provider.
    // (kosong generate() also does its own pre-flight check, but surfacing
    // the rejection here keeps stack traces tidy for Soul-level callers.)
    params.signal.throwIfAborted();

    // OAuth 401 layer wraps the transient-retry layer. A 401 short-circuits
    // any in-flight retry budget — we refresh once and re-enter `runOnce`
    // with a fresh retry budget. A second 401 (or refresh failure) escapes.
    try {
      try {
        return await this.runWithTransientRetry(params);
      } catch (error) {
        if (!isUnauthorizedError(error) || this.tokenRefresher === undefined) {
          throw error;
        }
        try {
          await this.tokenRefresher.refresh();
        } catch {
          throw error;
        }
        return await this.runWithTransientRetry(params);
      }
    } catch (error) {
      // Phase 18 A.13 — wrap any surviving provider failure in
      // `ProviderError` so the wire bridge can map it onto -32003.
      // The already-specific business/terminal errors (abort /
      // context-overflow / auth) pass through unchanged.
      if (this.isPassthroughError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderError(message, error);
    }
  }

  /**
   * Errors that already have a dedicated semantic handler downstream
   * and MUST NOT be rewrapped as `ProviderError`. Keeping this list
   * narrow matters — anything else bubbling up from the provider
   * layer is a candidate for the -32003 business mapping.
   */
  private isPassthroughError(error: unknown): boolean {
    if (error instanceof ContextOverflowError) return true;
    if (error instanceof ProviderError) return true;
    if (isUnauthorizedError(error)) return true;
    if (error instanceof Error && error.name === 'AbortError') return true;
    return false;
  }

  private async runWithTransientRetry(params: ChatParams): Promise<ChatResponse> {
    let attempt = 0;
    for (;;) {
      params.signal.throwIfAborted();
      try {
        return await this.runOnce(params);
      } catch (error) {
        // ContextOverflowError is a deterministic terminal — never retry.
        if (error instanceof ContextOverflowError) throw error;
        // Auth errors bubble to the outer 401 handler.
        if (isUnauthorizedError(error)) throw error;
        if (!isRetryableError(error)) throw error;
        if (attempt >= this.maxRetries) throw error;
        const delay = this.baseRetryDelayMs * 2 ** attempt + Math.floor(Math.random() * 500);
        attempt += 1;
        await sleep(delay, params.signal);
      }
    }
  }

  private async runOnce(params: ChatParams): Promise<ChatResponse> {
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
    let result: Awaited<ReturnType<typeof generate>>;
    try {
      result = await generate(
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
    } catch (err) {
      // Slice 5 / 决策 #96 L3 — normalise 17+ provider PTL/413 patterns
      // into a single ContextOverflowError identity so TurnManager can
      // catch with a single instanceof check.
      if (isContextOverflowProviderError(err)) {
        throw new ContextOverflowError(extractMessage(err));
      }
      throw err;
    }

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

    // Slice 5 / 决策 #96 L3 — silent overflow probe. The provider returned
    // successfully but its self-reported usage already breaches the
    // caller's contextWindow, meaning the next turn will certainly fail.
    // `usage.input` after `mapUsage` already aggregates inputOther +
    // inputCacheRead + inputCacheCreation, so it represents the full
    // input footprint for this call. Skipped when the caller did not
    // declare a contextWindow.
    if (params.contextWindow !== undefined && usage.input > params.contextWindow) {
      throw new ContextOverflowError(
        `Implicit context overflow: input=${String(usage.input)} exceeds contextWindow=${String(params.contextWindow)}`,
        usage,
      );
    }
    return response;
  }
}

// ── Provider error pattern detection ───────────────────────────────────

const PTL_MESSAGE_PATTERNS = [
  /context[\s_-]?length/i,
  /context[\s_-]?window/i,
  /prompt is too long/i,
  /payload too large/i,
  /maximum context length/i,
];

function isContextOverflowProviderError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const obj = err as Record<string, unknown>;
  // HTTP 413 — provider-agnostic.
  if (obj['status'] === 413) return true;
  // OpenAI / OpenRouter / many SDKs surface a string `code`.
  if (
    obj['code'] === 'context_length_exceeded' ||
    obj['code'] === 'context_window_exceeded' ||
    obj['code'] === 'string_above_max_length'
  ) {
    return true;
  }
  // Some adapters set a `type` discriminator instead of `code`.
  if (obj['type'] === 'context_window_exceeded') return true;
  // Anthropic-style: nested `error.type === 'invalid_request_error'`
  // plus a "prompt is too long" message — the message check below covers
  // the discriminator-less branch, but pin the explicit type here too.
  const nestedError = obj['error'];
  if (nestedError !== null && typeof nestedError === 'object') {
    const nested = nestedError as Record<string, unknown>;
    if (
      nested['type'] === 'context_window_exceeded' ||
      nested['type'] === 'context_length_exceeded'
    ) {
      return true;
    }
  }
  // Last resort: scan the message text for one of the well-known PTL
  // phrases. Be careful not to over-match generic 4xx errors — only
  // match when the message itself talks about context / prompt length.
  const message = extractMessage(err);
  if (message.length > 0) {
    for (const pattern of PTL_MESSAGE_PATTERNS) {
      if (pattern.test(message)) return true;
    }
  }
  return false;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err !== null && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(err);
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

// ── Slice 7.4 (决策 #94) — retry classification + abort-aware sleep ─────

const RETRYABLE_NODE_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED']);
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

export function isRetryableError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const obj = err as Record<string, unknown>;
  const code = obj['code'];
  if (typeof code === 'string' && RETRYABLE_NODE_ERROR_CODES.has(code)) return true;
  const status = obj['status'];
  if (typeof status === 'number' && RETRYABLE_HTTP_STATUSES.has(status)) return true;
  return false;
}

function isUnauthorizedError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const obj = err as Record<string, unknown>;
  if (obj['status'] === 401) return true;
  const code = obj['code'];
  if (typeof code === 'string' && code.toLowerCase() === 'unauthorized') return true;
  return false;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
