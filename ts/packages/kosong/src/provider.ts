import type { ModelCapability } from './capability.js';
import type { Message, StreamedMessagePart } from './message.js';
import type { Tool } from './tool.js';
import type { TokenUsage } from './usage.js';

/** Normalized thinking effort level used across all providers. */
export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high';

/**
 * Normalized finish-reason signal indicating why a generation stopped.
 *
 * Each provider's native stop value is mapped to one of these, and the
 * unmapped original string is preserved in `rawFinishReason` as an escape
 * hatch. `null` means the provider did not emit a finish_reason (e.g. the
 * stream was cut off before the final event).
 *
 * - `'completed'`: normal completion (OpenAI `'stop'`, Anthropic
 *   `'end_turn'` / `'stop_sequence'`, Gemini `'STOP'`).
 * - `'tool_calls'`: generation paused so the caller can dispatch tool
 *   calls and feed their results back. Note that the OpenAI Responses API
 *   and Google GenAI report `'completed'` here; only the Chat
 *   Completions–style providers and Anthropic surface a dedicated value.
 * - `'truncated'`: token budget exhausted (OpenAI `'length'`, Anthropic
 *   `'max_tokens'`, Gemini `'MAX_TOKENS'`, Responses `'max_output_tokens'`).
 * - `'filtered'`: content filter or safety policy blocked the response.
 * - `'paused'`: Anthropic-specific `'pause_turn'`.
 * - `'other'`: recognized non-null reason that does not fit the categories
 *   above.
 */
export type FinishReason =
  | 'completed'
  | 'tool_calls'
  | 'truncated'
  | 'filtered'
  | 'paused'
  | 'other';

/**
 * An async-iterable stream of message parts produced by a single LLM response.
 *
 * Consumers iterate over the stream with `for await..of` to receive
 * {@link StreamedMessagePart} chunks. After the iteration completes, the
 * {@link id}, {@link usage}, {@link finishReason}, and
 * {@link rawFinishReason} properties reflect the final values reported by
 * the provider.
 */
export interface StreamedMessage {
  [Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart>;
  /** Provider-assigned response identifier, or `null` if not available. */
  readonly id: string | null;
  /** Token usage statistics, populated after the stream completes. */
  readonly usage: TokenUsage | null;
  /**
   * Normalized finish reason, populated after the stream completes.
   *
   * `null` if the provider did not emit a finish_reason (for example, the
   * stream was interrupted before the final event arrived).
   */
  readonly finishReason: FinishReason | null;
  /**
   * Raw provider-specific finish_reason string, preserved verbatim as an
   * escape hatch for callers that need the original wire value.
   *
   * `null` if the provider did not emit a finish_reason.
   */
  readonly rawFinishReason: string | null;
}

/**
 * Options that can be forwarded to a single {@link ChatProvider.generate} call.
 */
export interface GenerateOptions {
  /**
   * An {@link AbortSignal} that, when aborted, requests cancellation of the
   * in-flight generate call. Providers that accept a signal will forward it
   * to their underlying HTTP client; the generate loop in
   * {@link generate | generate()} also checks the signal between streamed
   * parts.
   */
  signal?: AbortSignal;
}

/**
 * Unified interface for an LLM chat provider.
 *
 * Each provider implementation (Kimi, OpenAI, Anthropic, Google GenAI, etc.)
 * converts the common {@link Message} / {@link Tool} types into the
 * provider-specific wire format, streams back a {@link StreamedMessage}, and
 * exposes configuration helpers such as {@link withThinking}.
 */
export interface ChatProvider {
  /** Short identifier for the provider backend (e.g. `"kimi"`, `"anthropic"`). */
  readonly name: string;
  /** Model name passed to the upstream API (e.g. `"moonshot-v1-auto"`). */
  readonly modelName: string;
  /** Current thinking-effort level, or `null` if thinking is not configured. */
  readonly thinkingEffort: ThinkingEffort | null;
  /**
   * Send a conversation to the LLM and return a streamed response.
   *
   * @param systemPrompt - System-level instruction prepended to the request.
   * @param tools - Tool definitions the model may invoke.
   * @param history - The conversation history (user, assistant, tool messages).
   * @param options - Optional per-call settings such as an {@link AbortSignal}.
   */
  generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage>;
  /** Return a shallow copy of this provider with the given thinking effort. */
  withThinking(effort: ThinkingEffort): ChatProvider;
  /**
   * Return declared capabilities for `model` (defaults to `modelName`).
   *
   * Unknown / uncatalogued models return {@link UNKNOWN_CAPABILITY} rather
   * than throwing, so capability checks stay non-fatal and operators can
   * point at private/custom deployments without crashing.
   *
   * Optional on the interface so pre-existing test mocks (which predate
   * the capability matrix) still structurally satisfy `ChatProvider`
   * without churn. Callers that gate on modalities should fall back to
   * {@link UNKNOWN_CAPABILITY} when a provider does not expose it.
   */
  getCapability?(model?: string): ModelCapability;
}

/**
 * Optional interface for providers that support retry recovery.
 *
 * When a retryable error occurs (e.g. transient 5xx, rate-limit 429), the
 * retry loop calls {@link onRetryableError} to let the provider recreate its
 * HTTP client or perform other cleanup before the next attempt.
 */
export interface RetryableChatProvider extends ChatProvider {
  /**
   * Called before a retry attempt. Return `true` to proceed with the retry,
   * or `false` to abort.
   */
  onRetryableError(error: Error): boolean;
}
