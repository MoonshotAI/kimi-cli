import { APIEmptyResponseError } from './errors.js';
import {
  isContentPart,
  isToolCall,
  isToolCallPart,
  mergeInPlace,
  type Message,
  type StreamedMessagePart,
  type ToolCall,
} from './message.js';
import type { ChatProvider, GenerateOptions, StreamedMessage } from './provider.js';
import type { Tool } from './tool.js';
import type { TokenUsage } from './usage.js';

/** Snapshot of a ToolCall excluding the internal `_streamIndex` routing field. */
type StoredToolCall = Omit<ToolCall, '_streamIndex'>;

// ── Result ────────────────────────────────────────────────────────────

/**
 * The result of a single {@link generate} call.
 *
 * Contains the fully-assembled assistant {@link message}, an optional
 * provider-assigned {@link id}, and token {@link usage} statistics.
 */
export interface GenerateResult {
  /** Provider-assigned response identifier, or `null` if unavailable. */
  readonly id: string | null;
  /** The fully-assembled assistant message with merged content parts and tool calls. */
  readonly message: Message;
  /** Token usage for this generation, or `null` if not reported. */
  readonly usage: TokenUsage | null;
}

// ── Callbacks ─────────────────────────────────────────────────────────

export interface GenerateCallbacks {
  onMessagePart?: (part: StreamedMessagePart) => void | Promise<void>;
  onToolCall?: (toolCall: ToolCall) => void | Promise<void>;
}

// ── generate() ────────────────────────────────────────────────────────

/**
 * Generate one assistant message by streaming from the given provider.
 *
 * Parts of the message are streamed and merged: consecutive compatible parts
 * (e.g. TextPart + TextPart, ToolCall + ToolCallPart) are merged in-place so
 * the returned message always contains fully-assembled parts.
 *
 * **onToolCall firing**: The {@link GenerateCallbacks.onToolCall} callback is
 * fired once per fully-assembled tool call **after** the stream completes, in
 * the order they appear in `message.toolCalls`. Tool calls are never dispatched
 * mid-stream because parallel tool call streams may interleave arguments
 * (e.g. `tc0-header → tc1-header → tc0-args → tc1-args`), so the arguments of
 * any individual tool call are only guaranteed to be complete once the entire
 * stream has drained.
 *
 * @param provider - The chat provider to generate from.
 * @param systemPrompt - System-level instruction prepended to the request.
 * @param tools - Tool definitions the model may invoke.
 * @param history - The conversation history sent as context.
 * @param callbacks - Optional streaming callbacks.
 * @param options - Optional per-call settings (e.g. an {@link AbortSignal}).
 *
 * @throws {DOMException} with name `"AbortError"` when `options.signal` is
 *   aborted before or during streaming.
 * @throws {APIEmptyResponseError} when the response contains no content and
 *   no tool calls, or only thinking content without any text or tool calls.
 */
export async function generate(
  provider: ChatProvider,
  systemPrompt: string,
  tools: Tool[],
  history: Message[],
  callbacks?: GenerateCallbacks,
  options?: GenerateOptions,
): Promise<GenerateResult> {
  const message: Message = { role: 'assistant', content: [], toolCalls: [] };
  let pendingPart: StreamedMessagePart | null = null;

  // Map from provider streaming index (e.g. OpenAI Chat `index`, Responses
  // `item_id`) to the position inside `message.toolCalls`. Used to route
  // interleaved argument deltas from parallel tool calls to the correct call.
  const toolCallIndexMap = new Map<number | string, number>();

  // Pre-flight abort check: if the caller's signal is already aborted, we
  // must not issue the provider request at all. Providers that do not
  // themselves honor `signal` would otherwise emit a network call that the
  // caller has explicitly cancelled.
  if (options?.signal?.aborted) {
    throwAbortError();
  }

  const stream = await provider.generate(systemPrompt, tools, history, options);

  // Post-await abort check: `provider.generate()` may have resolved before
  // noticing a mid-flight abort. Reject immediately rather than draining
  // the stream.
  await throwIfAborted(options?.signal, stream);

  for await (const part of stream) {
    await throwIfAborted(options?.signal, stream);

    // Notify raw part callback (deep copy to avoid aliasing mutations).
    if (callbacks?.onMessagePart !== undefined) {
      await callbacks.onMessagePart(deepCopyPart(part));
      await throwIfAborted(options?.signal, stream);
    }

    // Index-based routing for parallel tool call argument deltas.
    // When a ToolCallPart arrives with an index referring to a tool call
    // that is NOT the currently-pending one, append it directly to the
    // correct ToolCall in message.toolCalls instead of relying on sequential
    // merging. This prevents argument cross-contamination across parallel calls.
    if (
      isToolCallPart(part) &&
      part.index !== undefined &&
      !isPendingToolCallAtIndex(pendingPart, part.index)
    ) {
      const arrayIdx = toolCallIndexMap.get(part.index);
      if (arrayIdx !== undefined) {
        const target = message.toolCalls[arrayIdx];
        if (target !== undefined && part.argumentsPart !== null) {
          target.function.arguments =
            target.function.arguments === null
              ? part.argumentsPart
              : target.function.arguments + part.argumentsPart;
        }
        continue;
      }
      // Unknown index — fall through to the sequential logic as a safety net.
    }

    if (pendingPart === null) {
      pendingPart = part;
    } else if (!mergeInPlace(pendingPart, part)) {
      // Could not merge — flush the pending part and start a new one.
      // For parallel tool calls this happens when a new ToolCall header arrives
      // while a previous ToolCall is still pending.
      flushPart(message, pendingPart, toolCallIndexMap);
      pendingPart = part;
    }
  }

  await throwIfAborted(options?.signal, stream);

  // Flush the last pending part.
  if (pendingPart !== null) {
    flushPart(message, pendingPart, toolCallIndexMap);
  }

  // ── Empty response checks ───────────────────────────────────────────

  if (message.content.length === 0 && message.toolCalls.length === 0) {
    throw new APIEmptyResponseError(
      `The API returned an empty response (no content, no tool calls). Provider: ${provider.name}, model: ${provider.modelName}`,
    );
  }

  // Think-only response (no real text, no tool calls) is treated as incomplete.
  const hasThink = message.content.some((p) => p.type === 'think');
  const hasText = message.content.some((p) => p.type === 'text' && p.text.trim().length > 0);
  const hasToolCalls = message.toolCalls.length > 0;

  if (hasThink && !hasText && !hasToolCalls) {
    throw new APIEmptyResponseError(
      'The API returned a response containing only thinking content ' +
        'without any text or tool calls. This usually indicates the ' +
        'stream was interrupted or the output token budget was exhausted ' +
        `during reasoning. Provider: ${provider.name}, model: ${provider.modelName}`,
    );
  }

  // Fire onToolCall for every fully-assembled tool call, in order.
  //
  // We deliberately defer this until after the stream has drained. Parallel
  // tool call streams may interleave argument deltas across calls (e.g.
  // tc0-header → tc1-header → tc0-args → tc1-args), so firing mid-stream would
  // dispatch a tool with half-parsed arguments and trigger toolParseError.
  if (callbacks?.onToolCall !== undefined) {
    for (const toolCall of message.toolCalls) {
      await throwIfAborted(options?.signal, stream);
      await callbacks.onToolCall(toolCall);
    }
  }

  return {
    id: stream.id,
    message,
    usage: stream.usage,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────

type CancelableStream = StreamedMessage & {
  cancel?: () => unknown;
  return?: () => unknown;
};

function throwAbortError(): never {
  throw new DOMException('The operation was aborted.', 'AbortError');
}

async function cancelStream(stream: StreamedMessage): Promise<void> {
  const cancelable = stream as CancelableStream;

  try {
    await cancelable.cancel?.();
  } catch {}

  try {
    await cancelable.return?.();
  } catch {}
}

async function throwIfAborted(signal?: AbortSignal, stream?: StreamedMessage): Promise<void> {
  if (!signal?.aborted) {
    return;
  }

  if (stream !== undefined) {
    await cancelStream(stream);
  }

  throwAbortError();
}

/** True when `pending` is a ToolCall whose _streamIndex equals `index`. */
function isPendingToolCallAtIndex(
  pending: StreamedMessagePart | null,
  index: number | string,
): boolean {
  return pending !== null && isToolCall(pending) && pending._streamIndex === index;
}

/**
 * Append a fully-merged part to the message.
 *
 * - ContentPart -> message.content
 * - ToolCall    -> message.toolCalls (the `_streamIndex` routing key is
 *                  registered in the map and stripped before storage).
 * - ToolCallPart -> ignored (orphaned delta)
 */
function flushPart(
  message: Message,
  part: StreamedMessagePart,
  toolCallIndexMap: Map<number | string, number>,
): void {
  if (isContentPart(part)) {
    message.content.push(part);
    return;
  }
  if (isToolCall(part)) {
    const streamIndex = part._streamIndex;
    const stored: StoredToolCall = {
      type: 'function',
      id: part.id,
      function: part.function,
      ...(part.extras !== undefined ? { extras: part.extras } : {}),
    };
    const storedCall = stored as ToolCall;
    const arrayIdx = message.toolCalls.length;
    message.toolCalls.push(storedCall);
    if (streamIndex !== undefined) {
      toolCallIndexMap.set(streamIndex, arrayIdx);
    }
  }
  // ToolCallPart: orphaned — silently ignore
}

/**
 * Produce a shallow-ish copy of a StreamedMessagePart.
 *
 * This is intentionally minimal: we only need isolation for the mutable
 * string fields that `mergeInPlace` mutates (text, think, arguments).
 */
function deepCopyPart(part: StreamedMessagePart): StreamedMessagePart {
  return structuredClone(part);
}
