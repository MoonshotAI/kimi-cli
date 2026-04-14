import { generate } from './generate.js';
import type { GenerateCallbacks, GenerateResult } from './generate.js';
import type { Message, StreamedMessagePart, ToolCall } from './message.js';
import type { ChatProvider, FinishReason, GenerateOptions } from './provider.js';
import type { ToolResult, Toolset } from './tool.js';
import type { TokenUsage } from './usage.js';

export type { GenerateResult } from './generate.js';
export { generate } from './generate.js';

// ── Callbacks ─────────────────────────────────────────────────────────

export interface StepCallbacks {
  onMessagePart?: (part: StreamedMessagePart) => void | Promise<void>;
  /** Sync-only callback fired when a tool result resolves. */
  onToolResult?: (result: ToolResult) => void;
}

// ── StepResult ────────────────────────────────────────────────────────

/**
 * The result of a single agent step.
 *
 * A step comprises one LLM generation followed by dispatch of any tool
 * calls the model requested. Tools are dispatched once the stream has
 * fully drained — this guarantees `toolCall.function.arguments` is
 * complete JSON even when a provider interleaves parallel tool call
 * argument deltas. Call {@link toolResults} to await all pending tool
 * executions in order.
 */
export interface StepResult {
  /** Provider-assigned response identifier, or `null` if unavailable. */
  readonly id: string | null;
  /** The fully-assembled assistant message produced during this step. */
  readonly message: Message;
  /** Token usage for this step's generation, or `null` if not reported. */
  readonly usage: TokenUsage | null;
  /**
   * Normalized finish reason reported by the provider, or `null` if no
   * finish_reason was emitted.
   */
  readonly finishReason: FinishReason | null;
  /**
   * Raw provider-specific finish_reason string preserved verbatim.
   * `null` if the provider did not emit one.
   */
  readonly rawFinishReason: string | null;
  /** Tool calls emitted by the model during this step (may be empty). */
  readonly toolCalls: ToolCall[];
  /**
   * Await all tool results dispatched during this step, returned in the
   * same order as {@link toolCalls}.
   */
  toolResults(): Promise<ToolResult[]>;
}

// ── step() ────────────────────────────────────────────────────────────

/**
 * Run one agent "step": generate an LLM response and dispatch any tool calls
 * through the toolset.
 *
 * Tool calls are dispatched after the provider stream has fully drained,
 * not while it is still producing parts. This guarantees each dispatched
 * {@link ToolCall} carries complete `function.arguments` JSON even when a
 * provider interleaves argument deltas across parallel tool calls. The
 * dispatched promises themselves still execute concurrently; the returned
 * {@link StepResult.toolResults} method awaits all of them in order.
 *
 * @param provider - The chat provider to generate from.
 * @param systemPrompt - System-level instruction prepended to the request.
 * @param toolset - The toolset that handles tool call dispatch.
 * @param history - The conversation history sent as context.
 * @param callbacks - Optional streaming and tool-result callbacks.
 * @param options - Optional per-call settings (e.g. an {@link AbortSignal}).
 *
 * @throws {ChatProviderError} (and subtypes) on provider failures.
 */
export async function step(
  provider: ChatProvider,
  systemPrompt: string,
  toolset: Toolset,
  history: Message[],
  callbacks?: StepCallbacks,
  options?: GenerateOptions,
): Promise<StepResult> {
  const toolCalls: ToolCall[] = [];
  const toolResultPromises = new Map<string, Promise<ToolResult>>();

  async function onToolCall(toolCall: ToolCall): Promise<void> {
    toolCalls.push(toolCall);

    const handleResult = toolset.handle(toolCall);

    // Normalise to a Promise regardless of whether handle() returned sync.
    const promise: Promise<ToolResult> =
      handleResult instanceof Promise ? handleResult : Promise.resolve(handleResult);

    // When the promise resolves, fire the onToolResult callback.
    const tracked = promise.then((result) => {
      if (callbacks?.onToolResult !== undefined) {
        callbacks.onToolResult(result);
      }
      return result;
    });

    toolResultPromises.set(toolCall.id, tracked);
    void tracked.catch(() => {});
  }

  let result: GenerateResult;
  try {
    const generateCallbacks: GenerateCallbacks = { onToolCall };
    if (callbacks?.onMessagePart !== undefined) {
      generateCallbacks.onMessagePart = callbacks.onMessagePart;
    }
    result = await generate(
      provider,
      systemPrompt,
      toolset.tools,
      history,
      generateCallbacks,
      options,
    );
  } catch (error: unknown) {
    // On provider or cancellation errors, cancel/await all pending tool
    // result promises to avoid dangling work.
    await cleanupPromises(toolResultPromises);
    throw error;
  }

  return {
    id: result.id,
    message: result.message,
    usage: result.usage,
    finishReason: result.finishReason,
    rawFinishReason: result.rawFinishReason,
    toolCalls,
    async toolResults(): Promise<ToolResult[]> {
      try {
        const results: ToolResult[] = [];
        for (const tc of toolCalls) {
          const promise = toolResultPromises.get(tc.id);
          if (promise !== undefined) {
            results.push(await promise);
          }
        }
        return results;
      } finally {
        // Ensure no dangling promises remain.
        await cleanupPromises(toolResultPromises);
      }
    },
  };
}

// ── Internal helpers ──────────────────────────────────────────────────

async function cleanupPromises(promises: Map<string, Promise<ToolResult>>): Promise<void> {
  // Await all, swallowing errors — they've already been reported or will
  // be reported via the original rejection.
  const values = [...promises.values()];
  if (values.length > 0) {
    await Promise.allSettled(values);
  }
}
