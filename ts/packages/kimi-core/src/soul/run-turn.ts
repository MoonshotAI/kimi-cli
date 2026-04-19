/**
 * `runSoulTurn` — the Soul agent loop as a **stateless function** (§5.1 / §5.0 rule 1).
 *
 * "Stateless" means: no `this`, no instance fields, no implicit cross-turn state.
 * Every `runSoulTurn` call is independent and does not depend on anything left
 * behind by a previous call.
 *
 * "Stateless" does **not** mean "side-effect free". Soul has five classes of side effect:
 *   1. Conversation state writes (context.appendStepBegin / appendContentPart /
 *      appendStepEnd / appendToolResult; fallback paths also call appendToolCall)
 *   2. UI event emits (sink.emit)
 *   3. LLM calls (runtime.kosong.chat)
 *   4. Tool execution (tool.execute)
 *   5. Compaction need signalling (via TurnResult.reason === 'needs_compaction')
 *
 * The value of "stateless" is "no implicit state between turns" — it enables
 * embedding Soul in hosts that don't want the full SoulPlus stack.
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

import { randomUUID } from 'node:crypto';

import type { SoulContextState } from '../storage/context-state.js';
import { adaptToolResult, buildLLMVisibleTools, toToolCallArgs } from './adapters.js';
import { shouldCompact } from './compaction.js';
import { MaxStepsExceededError } from './errors.js';
import type { EventSink, SoulEvent } from './event-sink.js';
import type { AtomicPart, ChatResponse, Runtime } from './runtime.js';
import type {
  BeforeToolCallResult,
  SoulConfig,
  SoulTurnOverrides,
  StopReason,
  TokenUsage,
  Tool,
  ToolCall,
  ToolResult,
  TurnResult,
  UserInput,
} from './types.js';

/**
 * Phase 25 Stage C — slice 25c-2 fallback when `SoulContextState` does not
 * implement `currentTurnId()` (legacy Soul fixtures that don't drive a
 * real turn manager). Production `BaseContextState` always exposes a real
 * turn id; the sentinel is used only in test fixtures that don't care
 * about the stamped value (they only check turn-id consistency between
 * related rows within the same step).
 */
const UNKNOWN_TURN_ID = 'unknown-turn';

const DEFAULT_MAX_STEPS = 100;

/**
 * Phase 17 §C.5 — grace timeout for tools that ignore their
 * AbortSignal. Once the turn-level abort fires, Soul waits up to
 * `GRACE_TIMEOUT_MS` for the tool's own promise to settle; if the
 * tool is still running past that window, Soul synthesises an
 * `is_error` ToolResult and moves on. The tool's background work
 * becomes orphaned (Node will GC it) — this only affects the in-turn
 * wait, not OS-level reaping.
 */
const GRACE_TIMEOUT_MS = 2_000;

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
  const usage: TokenUsage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let steps = 0;
  // §5.1.7 L1343: default `end_turn` — the loop always runs at least one
  // step that overwrites it, but the default matches spec so any downstream
  // turn_end record isn't polluted by `'unknown'`.
  let stopReason: StopReason = 'end_turn';

  try {
    while (true) {
      // §5.1.7 L1359: while-top safe point.
      signal.throwIfAborted();

      // Phase 2 (铁律 7): Soul detects compaction need and reports via
      // `TurnResult.stopReason='needs_compaction'`. TurnManager catches
      // this signal and runs `executeCompaction` (lifecycle +
      // compactionProvider + journal.rotate + context.resetToSummary)
      // before re-entering Soul on the same turn_id. Soul itself never
      // drives compaction — see src/soul-plus/turn-manager.ts.
      if (shouldCompact(context, config.compactionConfig)) {
        stopReason = 'needs_compaction';
        break;
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

      // M3: drain mid-turn state (notifications) into the ephemeral
      // stash before building messages. Aligns with Python's per-step
      // `deliver_pending("llm")` semantics. No-op when hook is unset
      // (pure-Soul tests / embeddings without TurnManager).
      context.beforeStep?.();

      const model = overrides?.model ?? context.model;
      const visibleTools = buildLLMVisibleTools(config.tools, overrides?.activeTools);
      const messages = context.buildMessages();

      // Phase 25 Stage C — slice 25c-2 atomic step envelope. Soul opens
      // the step with `appendStepBegin` BEFORE the LLM call so the WAL
      // carries a "step opened" row even when the chat itself aborts; on
      // abort the matching `appendStepEnd` is deliberately NOT written
      // (decision C6 partial-step — the missing step_end is the
      // replay-projector's interruption signal).
      const stepUuid = randomUUID();
      const turnId = context.currentTurnId?.() ?? UNKNOWN_TURN_ID;
      // Phase 25 Stage I (slice 25c-3) — fresh per-step bridge map.
      // The orchestrator's `appendToolCall` writer registers each
      // freshly-minted wireUuid under `toolCall.id`; Soul's happy-path
      // `appendToolResult` looks the parent uuid back up here. Allocated
      // per step (not per turn) so an entry from step N never leaks into
      // step N+1's parent lookup.
      const toolCallByProviderId = new Map<string, string>();

      await context.appendStepBegin({ uuid: stepUuid, turnId, step: currentStep });

      const response: ChatResponse = await runtime.kosong.chat({
        messages,
        tools: visibleTools,
        model,
        systemPrompt: context.systemPrompt,
        ...(overrides?.effort !== undefined ? { effort: overrides.effort } : {}),
        signal,
        onDelta: (delta) => {
          safeEmit(sink, { type: 'content.delta', delta });
        },
        onThinkDelta: (delta) => {
          safeEmit(sink, { type: 'thinking.delta', delta });
        },
        // Phase 17 §B.6 — forward incremental tool_call_part deltas
        // as their own SoulEvent variant. KosongAdapter emits one
        // per fully-assembled tool_call when the provider doesn't
        // chunk (fallback) or one per chunk when it does.
        onToolCallPart: (part) => {
          safeEmit(sink, {
            type: 'tool_call_part',
            tool_call_id: part.tool_call_id,
            ...(part.name !== undefined ? { name: part.name } : {}),
            ...(part.arguments_chunk !== undefined
              ? { arguments_chunk: part.arguments_chunk }
              : {}),
          });
        },
        // Phase 25 Stage C — stream completed content parts into the
        // atomic WAL writer anchored on the active `stepUuid`. Tool-call
        // fan-out is deferred to the orchestrator (slice 25c-3); we
        // intentionally no-op the `tool_call` branch here so the
        // happy-path `appendToolCall` row is NOT written twice.
        onAtomicPart: async (atomic: AtomicPart) => {
          if (atomic.kind !== 'content') return;
          const p = atomic.part;
          if (p.type === 'text') {
            await context.appendContentPart({
              uuid: randomUUID(),
              turnId,
              step: currentStep,
              stepUuid,
              part: { kind: 'text', text: p.text },
            });
            return;
          }
          const encrypted = p.encrypted;
          await context.appendContentPart({
            uuid: randomUUID(),
            turnId,
            step: currentStep,
            stepUuid,
            part:
              encrypted !== undefined
                ? { kind: 'think', think: p.think, encrypted }
                : { kind: 'think', think: p.think },
          });
        },
        ...(config.contextWindow !== undefined ? { contextWindow: config.contextWindow } : {}),
      });
      // Intentional: no `signal.throwIfAborted()` between the chat
      // return and Pass 1. The extra microtask hops added by
      // `await appendStepBegin` above + scripted-kosong's `onAtomicPart`
      // fan-out (await per tool_call) shift the moment an external
      // `controller.abort()` lands to AFTER kosong.chat resolves.
      // Throwing here would skip the dispatched tool_calls entirely so
      // signal-aware tools (SlowTool-style) never get to emit their own
      // AbortError — the transcript would carry step_end without a
      // matching tool_result for an LLM-emitted call. Abort detection
      // is delegated to tool.execute's own signal handling + the
      // post-Pass-2 checkpoint.

      usage.input += response.usage.input;
      usage.output += response.usage.output;
      usage.cache_read = (usage.cache_read ?? 0) + (response.usage.cache_read ?? 0);
      usage.cache_write = (usage.cache_write ?? 0) + (response.usage.cache_write ?? 0);

      // Pass 1 — in-Soul fallback writes, INSIDE the step envelope.
      // The three fallback classes (tool-not-found / zod parse-fail /
      // beforeToolCall hook throws) all share the same shape: Soul writes
      // BOTH an `appendToolCall` row (because the LLM emitted the call)
      // AND a parent-linked `appendToolResult` row (synthetic is_error).
      // Non-fallback calls get stashed for Pass 2 (happy path / hook-block
      // / real execution) which runs AFTER `appendStepEnd`.
      interface PendingCall {
        readonly toolCall: ToolCall;
        readonly tool: Tool;
        readonly parsedArgs: unknown;
        readonly hookResult: BeforeToolCallResult | undefined;
      }
      const pending: PendingCall[] = [];

      // Slice 4.2 pair invariant + 25c-2 split-pass reconciliation.
      // Wire writes are split (fallbacks inside step envelope, happy path
      // after stepEnd), but `tool.result` SoulEvents must still appear in
      // the same order as their matching `tool.call` events. Buffer per
      // tool_call_id and flush in `response.toolCalls` order in the
      // `finally` block below so the order survives every exit path —
      // including mid-Pass-2 throws from the afterToolCall AbortError
      // synthetic branch.
      interface DeferredToolResult {
        readonly output: string;
        readonly isError: boolean;
      }
      const deferredResults = new Map<string, DeferredToolResult>();
      const flushDeferredResults = (): void => {
        for (const tc of response.toolCalls) {
          const r = deferredResults.get(tc.id);
          if (r !== undefined) {
            emitToolResultEvent(sink, tc.id, r.output, r.isError);
            deferredResults.delete(tc.id);
          }
        }
      };

      try {
        for (const toolCall of response.toolCalls) {
          safeEmit(sink, {
            type: 'tool.call',
            toolCallId: toolCall.id,
            name: toolCall.name,
            args: toToolCallArgs(toolCall.args),
          });

          const tool = findTool(config.tools, toolCall.name);
          if (tool === undefined) {
            const output = `Tool "${toolCall.name}" not found`;
            await writeFallbackToolCallAndResult(
              context,
              stepUuid,
              turnId,
              currentStep,
              toolCall,
              output,
            );
            deferredResults.set(toolCall.id, { output, isError: true });
            continue;
          }

          const parsed = tool.inputSchema.safeParse(toolCall.args);
          if (!parsed.success) {
            const output = `Invalid input for tool "${toolCall.name}": ${parsed.error.message}`;
            await writeFallbackToolCallAndResult(
              context,
              stepUuid,
              turnId,
              currentStep,
              toolCall,
              output,
            );
            deferredResults.set(toolCall.id, { output, isError: true });
            continue;
          }

          let hookResult: BeforeToolCallResult | undefined;
          if (config.beforeToolCall !== undefined) {
            try {
              hookResult = await config.beforeToolCall(
                {
                  toolCall,
                  args: parsed.data,
                  assistantMessage: response.message,
                  context,
                  // Phase 25 Stage I (slice 25c-3) — per-step dynamic
                  // context for the orchestrator's `appendToolCall`
                  // writer + the shared map it stamps wireUuids into so
                  // Soul's happy-path `appendToolResult` can read them
                  // back as `parentUuid`.
                  turnId,
                  stepNumber: currentStep,
                  stepUuid,
                  toolCallByProviderId,
                },
                signal,
              );
            } catch (error) {
              const output = `beforeToolCall hook failed for "${toolCall.name}": ${errorMessage(error)}`;
              await writeFallbackToolCallAndResult(
                context,
                stepUuid,
                turnId,
                currentStep,
                toolCall,
                output,
              );
              deferredResults.set(toolCall.id, { output, isError: true });
              // Non-fallback errors surface through the next iteration's
              // `signal.throwIfAborted()` (abort path) or the post-loop
              // checkpoint; keep the loop moving so all tool_calls get
              // balanced tool_result rows.
              continue;
            }
          }

          pending.push({ toolCall, tool, parsedArgs: parsed.data, hookResult });
        }

        // Close the step envelope. Usage from the LLM response rides on
        // `step_end` (25c-1 semantics — `tokenCountWithPending` advances
        // here, not on the legacy aggregated write). The `finishReason`
        // field is stamped only when the adapter reported a stopReason so
        // omitted-vs-present stays consistent with §A.2.
        const stepEndUsage = {
          input_tokens: response.usage.input,
          output_tokens: response.usage.output,
          ...(response.usage.cache_read !== undefined
            ? { cache_read_tokens: response.usage.cache_read }
            : {}),
          ...(response.usage.cache_write !== undefined
            ? { cache_write_tokens: response.usage.cache_write }
            : {}),
        };
        await context.appendStepEnd({
          uuid: stepUuid,
          turnId,
          step: currentStep,
          usage: stepEndUsage,
          ...(response.stopReason !== undefined ? { finishReason: response.stopReason } : {}),
        });
        // Intentional: no `signal.throwIfAborted()` between here and the
        // first `tool.execute` call. If we aborted before entering
        // `tool.execute`, a signal-aware tool would never get a chance to
        // reject and write its own synthetic error tool_result — the
        // transcript would be unbalanced (step_end without a matching
        // tool_result for a dispatched tool_call). Between-tool abort
        // protection is provided by the `if (index > 0)` checkpoint
        // inside Pass 2 plus the post-for-loop checkpoint.

        // Pass 2 — happy-path executions + hook-block outcomes, written
        // OUTSIDE the step envelope. `appendToolResult` reads `parentUuid`
        // from the per-step `toolCallByProviderId` map (populated by the
        // orchestrator's `appendToolCall` write, slice 25c-3). Falls back
        // to `undefined` on a miss (embed / pure-Soul tests without an
        // orchestrator hook) — the replay-projector still links via
        // `tool_call_id` in that legacy shape.
        for (const [index, item] of pending.entries()) {
          if (index > 0) {
            // §5.1.7 L1425 (relaxed — see comment above): skip tool #2+
            // if an abort landed during the previous iteration. Tool #1 is
            // always allowed to enter `tool.execute` so signal-aware tools
            // can write their own synthetic error before we bail.
            signal.throwIfAborted();
          }

          const { toolCall, tool, parsedArgs, hookResult } = item;
          let effectiveInput: unknown = parsedArgs;

          if (hookResult?.block === true) {
            const output = hookResult.reason ?? `Tool call "${toolCall.name}" was blocked`;
            deferredResults.set(toolCall.id, { output, isError: true });
            // Phase 25 Stage I (slice 25c-3) — block path never reaches
            // the orchestrator's `appendToolCall` writer (the hook
            // short-circuits at permission/preHook), so the map lookup
            // returns `undefined` and the result row stays parent-less.
            await context.appendToolResult(
              toolCallByProviderId.get(toolCall.id),
              toolCall.id,
              { output, isError: true },
            );
            continue;
          }
          if (hookResult?.updatedInput !== undefined) {
            effectiveInput = hookResult.updatedInput;
          }

          let toolResult: ToolResult;
          try {
            // Slice 5 / 决策 #97 — streaming prefetch shortcut. When the
            // KosongAdapter wraps a streaming provider it may stash an
            // already-computed result for this `toolCall.id`; on a hit Soul
            // reuses the result verbatim and skips `tool.execute`. Phase 5
            // adapters never populate the map, so the else branch always
            // runs.
            const prefetched = response._prefetchedToolResults?.get(toolCall.id);
            if (prefetched !== undefined) {
              toolResult = prefetched;
            } else {
              const executePromise = tool.execute(
                toolCall.id,
                effectiveInput,
                signal,
                (update) => {
                  safeEmit(sink, {
                    type: 'tool.progress',
                    toolCallId: toolCall.id,
                    update,
                  });
                },
              );
              // Phase 17 §C.5 — race tool.execute against a grace timer
              // that arms on abort. A well-behaved tool settles (rejects
              // with AbortError) before the grace window fires; a
              // non-cooperative one (no abort listener) hangs forever
              // and the grace sentinel wins.
              toolResult = await raceExecuteWithGraceTimeout(
                executePromise,
                signal,
                toolCall.name,
              );
            }
          } catch (error) {
            const aborted = isAbortError(error) || signal.aborted;
            const output = aborted
              ? `Tool "${toolCall.name}" was aborted`
              : `Tool "${toolCall.name}" failed: ${errorMessage(error)}`;
            const syntheticResult: ToolResult = { content: output, isError: true };
            deferredResults.set(toolCall.id, { output, isError: true });
            await context.appendToolResult(
              toolCallByProviderId.get(toolCall.id),
              toolCall.id,
              { output, isError: true },
            );
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
          let afterError: unknown;
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
            } catch (error) {
              afterError = error;
            }
          }

          if (afterError !== undefined) {
            // afterToolCall is a redaction/truncation seam (§5.1.3). When it
            // fails we MUST NOT durable-write the raw `toolResult`, because
            // the seam's job may have been to strip sensitive content out of
            // it. Instead:
            //   - abort: write a synthetic aborted tool_result and rethrow
            //     so the outer catch converges on stopReason='aborted'.
            //     The `finally` below flushes the deferred event BEFORE the
            //     throw propagates so the TUI still sees a balanced pair.
            //   - non-abort: write a synthetic error tool_result explaining
            //     the hook failure and continue to the next tool call.
            if (isAbortError(afterError) || signal.aborted) {
              const output = `Tool "${toolCall.name}" aborted during afterToolCall hook.`;
              deferredResults.set(toolCall.id, { output, isError: true });
              await context.appendToolResult(
                toolCallByProviderId.get(toolCall.id),
                toolCall.id,
                { output, isError: true },
              );
              throw afterError instanceof Error ? afterError : new Error(errorMessage(afterError));
            }
            const output = `afterToolCall hook failed for "${toolCall.name}": ${errorMessage(afterError)}`;
            deferredResults.set(toolCall.id, { output, isError: true });
            await context.appendToolResult(
              toolCallByProviderId.get(toolCall.id),
              toolCall.id,
              { output, isError: true },
            );
            continue;
          }

          const adapted = adaptToolResult(finalResult);
          // `adapted.output` is `unknown` at the type level but always
          // comes from `adaptToolResult` which coalesces every shape
          // into a string. Normalise defensively so the SoulEvent
          // variant (which constrains `output: string`) type-checks
          // without a cast at the call site.
          const adaptedText =
            typeof adapted.output === 'string' ? adapted.output : JSON.stringify(adapted.output);
          deferredResults.set(toolCall.id, {
            output: adaptedText,
            isError: finalResult.isError === true,
          });
          // Phase 25 Stage I (slice 25c-3) — happy-path parent uuid is
          // the wireUuid the orchestrator stamped during
          // `buildBeforeToolCall`. Falls back to `undefined` when no
          // orchestrator wiring is present (embed / pure-Soul tests),
          // preserving slice 25c-2 semantics for those callers.
          await context.appendToolResult(
            toolCallByProviderId.get(toolCall.id),
            toolCall.id,
            adapted,
          );
        }

        // §5.1.7 L1500: checkpoint after the tool for loop (catches any
        // abort that landed during/after the final tool_result write).
        signal.throwIfAborted();
      } finally {
        flushDeferredResults();
      }

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
  // §4.6.3 rule 3: listener errors must never reach Soul.
  //
  // EventSink.emit is declared `void` (§4.6.2) but TypeScript structurally
  // allows an `async emit()` implementation to be assigned to a
  // `(event) => void` slot. Soul deliberately does not await the return,
  // but a rejected promise from an async listener would still surface as
  // an unhandled rejection at the Node process level. We attach a
  // terminal `.catch()` to thenable returns so the rejection is contained
  // here instead of crashing the host under strict mode.
  let maybePromise: unknown;
  try {
    // Invoke through the bound method so `this` is preserved for class
    // implementations. Soul never awaits the return — it only attaches a
    // terminal .catch for rejection containment.
    maybePromise = (sink.emit.bind(sink) as (event: SoulEvent) => unknown)(event);
  } catch {
    // swallow sync listener throw
    return;
  }
  if (
    maybePromise !== undefined &&
    maybePromise !== null &&
    typeof (maybePromise as { then?: unknown }).then === 'function' &&
    typeof (maybePromise as { catch?: unknown }).catch === 'function'
  ) {
    (maybePromise as Promise<unknown>).catch(() => {
      // swallow async listener rejection
    });
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

/**
 * Slice 4.2 — emit a `tool.result` SoulEvent right before each
 * `context.appendToolResult` call so TUI bridges can close the
 * `tool.call` → `tool.result` pair without wrapping every tool.
 * `isError` is optional on the event variant; only set when true so
 * the wire message stays close to Python parity (omit-on-false).
 */
function emitToolResultEvent(
  sink: EventSink,
  toolCallId: string,
  output: string,
  isError: boolean,
): void {
  safeEmit(sink, {
    type: 'tool.result',
    toolCallId,
    output,
    ...(isError ? { isError: true } : {}),
  });
}

/**
 * Phase 25 Stage C — slice 25c-2 Pass 1 fallback writer. The three
 * in-Soul fallback classes (tool-not-found / zod-parse-fail /
 * beforeToolCall hook throws) all share the same transcript shape:
 *   1. `appendToolCall` anchored on the active `stepUuid` so the LLM's
 *      emitted call is durable before the synthetic result lands.
 *   2. `appendToolResult` with `parentUuid` pointing at the fresh
 *      tool_call row so the replay-projector can reconstruct the
 *      parent link without scanning history for a `tool_call_id` match.
 *
 * The matching `tool.result` SoulEvent is NOT emitted here — it is
 * staged into the caller's `deferredResults` buffer and flushed in
 * `response.toolCalls` order at the end of the step so Slice 4.2's
 * "tool.call → tool.result events in the same order" invariant still
 * holds when fallback (pre-stepEnd) writes interleave with happy-path
 * (post-stepEnd) writes.
 *
 * Kept as a local helper (not exported) — it's load-bearing for the
 * 25c-2 Pass 1 invariant and nothing outside `runSoulTurn` should be
 * driving these writes.
 */
async function writeFallbackToolCallAndResult(
  context: SoulContextState,
  stepUuid: string,
  turnId: string,
  step: number,
  toolCall: ToolCall,
  output: string,
): Promise<void> {
  const toolCallUuid = randomUUID();
  await context.appendToolCall({
    uuid: toolCallUuid,
    turnId,
    step,
    stepUuid,
    data: {
      tool_call_id: toolCall.id,
      tool_name: toolCall.name,
      args: toolCall.args,
    },
  });
  await context.appendToolResult(toolCallUuid, toolCall.id, {
    output,
    isError: true,
  });
}

/**
 * Phase 17 §C.5 — race the tool's execute promise against a grace
 * timer that arms on abort. Returns the tool's result if it settles
 * first, or a synthetic `is_error` ToolResult when the grace window
 * expires. The tool's promise is intentionally orphaned in the
 * grace-timeout branch: Soul has no way to force-kill tool-internal
 * timers, and the caller moves on regardless.
 */
async function raceExecuteWithGraceTimeout(
  executePromise: Promise<ToolResult>,
  signal: AbortSignal,
  toolName: string,
): Promise<ToolResult> {
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const graceSentinel: Promise<ToolResult> = new Promise((resolve) => {
    const armTimer = (): void => {
      graceTimer = setTimeout(() => {
        resolve({
          content: `Tool "${toolName}" aborted by grace timeout (${String(GRACE_TIMEOUT_MS)}ms)`,
          isError: true,
        });
      }, GRACE_TIMEOUT_MS);
    };
    if (signal.aborted) {
      armTimer();
    } else {
      onAbort = armTimer;
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    return await Promise.race([executePromise, graceSentinel]);
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (onAbort !== undefined) {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        /* some AbortSignal polyfills don't implement removeEventListener */
      }
    }
  }
}
