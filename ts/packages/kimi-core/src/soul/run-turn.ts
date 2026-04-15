/**
 * `runSoulTurn` — the Soul agent loop as a pure function (§5.1 / §5.0 rule 1).
 *
 * Canonical signature per §5.1.2:
 *
 *   export async function runSoulTurn(
 *     input: UserInput,
 *     config: SoulConfig,
 *     context: SoulContextState,
 *     runtime: Runtime,
 *     sink: EventSink,
 *     signal: AbortSignal,
 *     overrides?: SoulTurnOverrides,
 *   ): Promise<TurnResult>;
 */

import type { SoulContextState } from '../storage/context-state.js';
import {
  adaptAssistantMessage,
  adaptToolResult,
  buildLLMVisibleTools,
  toToolCallArgs,
} from './adapters.js';
import { runCompaction, shouldCompact } from './compaction.js';
import { MaxStepsExceededError } from './errors.js';
import type { EventSink, SoulEvent } from './event-sink.js';
import type { ChatResponse, Runtime } from './runtime.js';
import type {
  BeforeToolCallResult,
  SoulConfig,
  SoulTurnOverrides,
  StopReason,
  TokenUsage,
  Tool,
  ToolResult,
  TurnResult,
  UserInput,
} from './types.js';

const DEFAULT_MAX_STEPS = 100;

export async function runSoulTurn(
  _input: UserInput,
  config: SoulConfig,
  context: SoulContextState,
  runtime: Runtime,
  sink: EventSink,
  signal: AbortSignal,
  overrides?: SoulTurnOverrides,
): Promise<TurnResult> {
  const maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS;
  const usage: TokenUsage = { input: 0, output: 0 };
  let steps = 0;
  // §5.1.7 L1343: default `end_turn` — the loop always runs at least one
  // step that overwrites it, but the default matches spec so any downstream
  // turn_end record isn't polluted by `'unknown'`.
  let stopReason: StopReason = 'end_turn';

  try {
    while (true) {
      // §5.1.7 L1359: while-top safe point.
      signal.throwIfAborted();

      // §5.1.7 L1361-L1366: compaction gate. Triggers when token count
      // crosses the configured threshold. Disabled when compactionConfig
      // is not provided (shouldCompact returns false for undefined config).
      if (shouldCompact(context, config.compactionConfig)) {
        await runCompaction(context, runtime, sink, signal);
        continue;
      }

      // §5.1.3 maxSteps guard.
      if (steps >= maxSteps) {
        throw new MaxStepsExceededError(maxSteps);
      }

      steps += 1;
      const currentStep = steps;
      safeEmit(sink, { type: 'step.begin', step: currentStep });

      // §5.1.7 L1377-L1385: drain steer BEFORE the LLM call.
      const drained = context.drainSteerMessages();
      if (drained.length > 0) {
        await context.addUserMessages(drained);
      }
      // §5.1.7 L1384: checkpoint after addUserMessages.
      signal.throwIfAborted();

      const model = overrides?.model ?? context.model;
      const visibleTools = buildLLMVisibleTools(config.tools, overrides?.activeTools);
      const messages = context.buildMessages();

      const response: ChatResponse = await runtime.kosong.chat({
        messages,
        tools: visibleTools,
        model,
        ...(overrides?.effort !== undefined ? { effort: overrides.effort } : {}),
        signal,
        onDelta: (delta) => {
          safeEmit(sink, { type: 'content.delta', delta });
        },
      });
      // §5.1.7 L1407: checkpoint after kosong.chat catches any abort that
      // landed while the chat promise was pending but that the adapter
      // resolved normally anyway.
      signal.throwIfAborted();

      usage.input += response.usage.input;
      usage.output += response.usage.output;

      const assistantPayload = adaptAssistantMessage(response, model);
      await context.appendAssistantMessage(assistantPayload);
      // Intentional: no `signal.throwIfAborted()` between here and the
      // first `tool.execute` call. The microtask hop from
      // `await appendAssistantMessage` is the exact window in which an
      // external `controller.abort()` (queued via `queueMicrotask` in
      // tests) lands. If we aborted before entering `tool.execute`, a
      // signal-aware tool would never get a chance to reject and write
      // its own synthetic error tool_result — the transcript would be
      // unbalanced (assistant with tool_calls but zero tool_results).
      // Between-tool abort protection is provided by the `if (index > 0)`
      // checkpoint below plus the post-for-loop checkpoint.

      for (const [index, toolCall] of response.toolCalls.entries()) {
        if (index > 0) {
          // §5.1.7 L1425 (relaxed — see comment above): skip tool #2+
          // if an abort landed during the previous iteration. Tool #1 is
          // always allowed to enter `tool.execute` so signal-aware tools
          // can write their own synthetic error before we bail.
          signal.throwIfAborted();
        }

        safeEmit(sink, {
          type: 'tool.call',
          toolCallId: toolCall.id,
          name: toolCall.name,
          args: toToolCallArgs(toolCall.args),
        });

        const tool = findTool(config.tools, toolCall.name);
        if (tool === undefined) {
          await context.appendToolResult(toolCall.id, {
            output: `Tool "${toolCall.name}" not found`,
            isError: true,
          });
          continue;
        }

        const parsed = tool.inputSchema.safeParse(toolCall.args);
        if (!parsed.success) {
          await context.appendToolResult(toolCall.id, {
            output: `Invalid input for tool "${toolCall.name}": ${parsed.error.message}`,
            isError: true,
          });
          continue;
        }

        let effectiveInput: unknown = parsed.data;

        if (config.beforeToolCall !== undefined) {
          let hookResult: BeforeToolCallResult | undefined;
          try {
            hookResult = await config.beforeToolCall(
              {
                toolCall,
                args: parsed.data,
                assistantMessage: response.message,
                context,
              },
              signal,
            );
          } catch (error) {
            await context.appendToolResult(toolCall.id, {
              output: `beforeToolCall hook failed for "${toolCall.name}": ${errorMessage(error)}`,
              isError: true,
            });
            // Next iteration's `signal.throwIfAborted()` picks up an
            // abort-flavoured failure; non-abort errors just continue.
            continue;
          }

          if (hookResult?.block === true) {
            await context.appendToolResult(toolCall.id, {
              output: hookResult.reason ?? `Tool call "${toolCall.name}" was blocked`,
              isError: true,
            });
            continue;
          }
          if (hookResult?.updatedInput !== undefined) {
            effectiveInput = hookResult.updatedInput;
          }
        }

        let toolResult: ToolResult;
        try {
          toolResult = await tool.execute(toolCall.id, effectiveInput, signal, (update) => {
            safeEmit(sink, {
              type: 'tool.progress',
              toolCallId: toolCall.id,
              update,
            });
          });
        } catch (error) {
          const aborted = isAbortError(error) || signal.aborted;
          const syntheticResult: ToolResult = {
            content: aborted
              ? `Tool "${toolCall.name}" was aborted`
              : `Tool "${toolCall.name}" failed: ${errorMessage(error)}`,
            isError: true,
          };
          await context.appendToolResult(toolCall.id, {
            output: syntheticResult.content as string,
            isError: true,
          });
          // Fire afterToolCall with the synthetic error result so
          // OnToolFailure hooks can observe tool exceptions (Slice 4).
          if (config.afterToolCall !== undefined) {
            try {
              await config.afterToolCall(
                { toolCall, args: effectiveInput, result: syntheticResult, context },
                signal,
              );
            } catch {
              // swallow — same policy as the normal afterToolCall path
            }
          }
          continue;
        }

        let finalResult = toolResult;
        if (config.afterToolCall !== undefined) {
          try {
            const afterResult = await config.afterToolCall(
              {
                toolCall,
                args: effectiveInput,
                result: toolResult,
                context,
              },
              signal,
            );
            if (afterResult?.resultOverride !== undefined) {
              finalResult = afterResult.resultOverride;
            }
          } catch {
            // afterToolCall errors (abort or non-abort) fall through:
            // the original result is still written so the transcript
            // stays balanced. An aborted signal is caught by the next
            // `signal.throwIfAborted()`.
          }
        }

        await context.appendToolResult(toolCall.id, adaptToolResult(finalResult));
      }

      // §5.1.7 L1500: checkpoint after the tool for loop (catches any
      // abort that landed during/after the final tool_result write).
      signal.throwIfAborted();

      safeEmit(sink, { type: 'step.end', step: currentStep });

      const sr = response.stopReason ?? 'end_turn';
      if (sr === 'tool_use') {
        continue;
      }
      stopReason = sr;
      break;
    }
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      safeEmit(sink, {
        type: 'step.interrupted',
        step: Math.max(steps, 1),
        reason: 'aborted',
      });
      return { stopReason: 'aborted', steps, usage };
    }
    safeEmit(sink, {
      type: 'step.interrupted',
      step: Math.max(steps, 1),
      reason: error instanceof MaxStepsExceededError ? 'max_steps' : 'error',
    });
    throw error;
  }

  return { stopReason, steps, usage };
}

// ── Private helpers ────────────────────────────────────────────────────

function safeEmit(sink: EventSink, event: SoulEvent): void {
  try {
    sink.emit(event);
  } catch {
    // §4.6.3 rule 3: listener errors must never reach Soul.
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === 'AbortError';
  }
  return false;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function findTool(tools: readonly Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
