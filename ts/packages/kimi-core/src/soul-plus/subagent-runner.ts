/**
 * SubagentRunner — core `runSubagentTurn` implementation.
 *
 * Python parity:
 *   - `kimi_cli.subagents.runner.ForegroundSubagentRunner.run()`
 *   - `kimi_cli.subagents.core.prepare_soul()`
 *
 * This module provides the `runSubagentTurn` callback that SoulRegistry
 * invokes when AgentTool calls `SubagentHost.spawn()`. It creates a child
 * Soul infrastructure (ContextState, JournalWriter, Runtime, EventSink)
 * and runs a single Soul turn with a filtered tool set.
 */

import { runSoulTurn } from '../soul/index.js';
import type { EventSink, Runtime, SoulConfig, Tool } from '../soul/index.js';
import type { SoulEvent } from '../soul/event-sink.js';
import { InMemoryContextState } from '../storage/context-state.js';
import type { AgentResult, SpawnRequest } from './subagent-types.js';
import type { AgentTypeRegistry } from './agent-type-registry.js';
import { collectGitContext } from './git-context.js';
import type { SubagentStore } from './subagent-store.js';
import {
  SubagentRuntimeLifecycleGate,
  SUBAGENT_JOURNAL_CAPABILITY,
} from './subagent-lifecycle-gate.js';

// ── Summary continuation constants (Python parity: runner.py) ────────

const SUMMARY_MIN_LENGTH = 200;
const SUMMARY_CONTINUATION_ATTEMPTS = 1;
const SUMMARY_CONTINUATION_PROMPT =
  'Your response was too short. Please provide a more detailed summary of what you did, what you found, and any relevant details.';

// ── Dependencies ──────────────────────────────────────────────────────

export interface SubagentRunnerDeps {
  readonly store: SubagentStore;
  readonly typeRegistry: AgentTypeRegistry;
  readonly parentTools: readonly Tool[];
  readonly parentRuntime: Runtime;
  readonly parentSink: EventSink;
  readonly sessionDir: string;
  /** Model name to use for child context (parent's current model). */
  readonly parentModel: string;
  /**
   * Working directory for git context injection (explore agents).
   * When absent, defaults to `process.cwd()`.
   */
  readonly workDir?: string | undefined;
}

// ── runSubagentTurn ───────────────────────────────────────────────────

/**
 * Execute a single subagent turn. This is the callback wired into
 * `SoulRegistry.runSubagentTurn`.
 *
 * Flow:
 *   1. Resolve agent type + filter tools
 *   2. Create child infrastructure (context, journal, runtime, sink)
 *   3. Persist initial meta.json
 *   4. Run Soul turn
 *   5. Extract result + update status
 */
export async function runSubagentTurn(
  deps: SubagentRunnerDeps,
  agentId: string,
  request: SpawnRequest,
  signal: AbortSignal,
): Promise<AgentResult> {
  const { store, typeRegistry, parentTools, parentRuntime, parentSink, parentModel } = deps;

  // 1. Resolve type definition + build filtered tool set
  const typeDef = typeRegistry.resolve(request.agentName);
  const childTools = typeRegistry.resolveToolSet(request.agentName, parentTools);

  // 2. Persist initial instance record
  await store.createInstance({
    agentId,
    subagentType: request.agentName,
    description: request.description ?? request.agentName,
    parentToolCallId: request.parentToolCallId,
  });

  // 3. Create child infrastructure

  // Build system prompt for child. Since Slice 6.0, loadSubagentTypes()
  // reads system_prompt_path (system.md) and renders the full template
  // with nunjucks, so systemPromptSuffix now contains the complete
  // system prompt (base + ROLE_ADDITIONAL), not just the suffix.
  const childSystemPrompt = typeDef.systemPromptSuffix || undefined;

  // Determine child model: request override > type default > parent model
  const childModel = request.model ?? typeDef.defaultModel ?? parentModel;

  // Child gets a fresh in-memory context with NoopJournalWriter (no resume in 5.3).
  // The child's conversation isn't persisted — wire events are captured via the
  // bubbling sink and written to the parent's journal as SubagentEventRecords.
  const childContext = new InMemoryContextState({
    initialModel: childModel,
    ...(childSystemPrompt !== undefined ? { initialSystemPrompt: childSystemPrompt } : {}),
  });

  // Child runtime reuses parent's kosong + compactionProvider.
  // Lifecycle and journal are stubs — subagents don't compact.
  const childRuntime: Runtime = {
    kosong: parentRuntime.kosong,
    compactionProvider: parentRuntime.compactionProvider,
    lifecycle: new SubagentRuntimeLifecycleGate(),
    journal: SUBAGENT_JOURNAL_CAPABILITY,
  };

  // Child event sink: collects content deltas for the final response
  // and bubbles events to the parent sink for live display.
  const contentCollector: string[] = [];
  const childSink = createBubblingSink(
    parentSink,
    agentId,
    request.agentName,
    request.parentToolCallId,
    contentCollector,
  );

  const childConfig: SoulConfig = {
    tools: childTools,
    // Subagents auto-approve all tool calls in 5.3
    // (no beforeToolCall / afterToolCall hooks)
  };

  // 4. Update status to running
  await store.updateInstance(agentId, { status: 'running' });

  // 4.5. Git-context injection for explore agents (Slice 6.0)
  let prompt = request.prompt;
  if (request.agentName === 'explore') {
    const effectiveWorkDir = deps.workDir ?? process.cwd();
    const gitCtx = await collectGitContext(effectiveWorkDir);
    if (gitCtx) {
      prompt = `${gitCtx}\n\n${prompt}`;
    }
  }

  // 4.6. Append user message to child context so runSoulTurn can see it
  // in context.buildMessages(). runSoulTurn's _input parameter is unused;
  // TurnManager calls appendUserMessage before runSoulTurn, and the
  // subagent runner must do the same.
  await childContext.appendUserMessage({ text: prompt });

  // 5. Run the Soul turn
  let turnResult;
  try {
    turnResult = await runSoulTurn(
      { text: prompt },
      childConfig,
      childContext,
      childRuntime,
      childSink,
      signal,
    );
  } catch (error) {
    // Determine if abort or error
    if (signal.aborted) {
      await store.updateInstance(agentId, { status: 'killed' });
    } else {
      await store.updateInstance(agentId, { status: 'failed' });
    }
    throw error;
  }

  // 6. Check for abort (runSoulTurn returns normally with stopReason='aborted')
  if (turnResult.stopReason === 'aborted') {
    await store.updateInstance(agentId, { status: 'killed' });
    throw new Error('Subagent was aborted');
  }

  // 7. Extract result and update status
  let resultText = contentCollector.join('');
  const usage = turnResult.usage;

  // 7.5 Summary continuation: if response is too short, ask for more detail.
  // Python parity: runner.py SUMMARY_MIN_LENGTH / SUMMARY_CONTINUATION_ATTEMPTS
  if (resultText.length < SUMMARY_MIN_LENGTH) {
    const originalResult = resultText;
    for (let i = 0; i < SUMMARY_CONTINUATION_ATTEMPTS; i++) {
      try {
        contentCollector.length = 0; // reset collector
        // Append continuation prompt as a user message so the child context
        // includes it in buildMessages() for the next runSoulTurn call.
        await childContext.appendUserMessage({ text: SUMMARY_CONTINUATION_PROMPT });
        await runSoulTurn(
          { text: SUMMARY_CONTINUATION_PROMPT },
          childConfig,
          childContext, // reuse same context (has history)
          childRuntime,
          childSink,
          signal,
        );
        resultText = contentCollector.join('');
        if (resultText.length >= SUMMARY_MIN_LENGTH) break;
      } catch {
        // Continuation failed — fall back to first response
        resultText = originalResult;
        break;
      }
    }
  }

  // Python writes 'idle' here (runner.py:338) to signal "reusable for resume".
  // TS uses 'completed' as the terminal success state — SubagentStatus doesn't
  // include 'idle'. Future resume logic must treat 'completed' as resumable
  // (same as Python's 'idle' + 'failed' + 'completed').
  await store.updateInstance(agentId, { status: 'completed' });

  return { result: resultText, usage };
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Create an EventSink that:
 *   1. Collects content.delta texts into `contentCollector` for the final response
 *   2. Bubbles content/thinking deltas to parent sink for live display
 *
 * Python parity: `runner.py:390-425` (_make_ui_loop_fn)
 *
 * Note: SubagentEventRecords are NOT written from here in 5.3. The child's
 * events flow through the parent's event bus naturally via the bubbled
 * content/thinking deltas. Full SubagentEventRecord journaling (to the
 * parent wire.jsonl) is deferred to 5.x when the parent SessionJournal
 * is available in the runner deps.
 */
function createBubblingSink(
  parentSink: EventSink,
  _agentId: string,
  _agentName: string,
  _parentToolCallId: string,
  contentCollector: string[],
): EventSink {
  return {
    emit(event: SoulEvent): void {
      // Collect content deltas for the final response text
      if (event.type === 'content.delta') {
        contentCollector.push(event.delta);
      }

      // Bubble content/thinking deltas to parent for live TUI display
      if (event.type === 'content.delta' || event.type === 'thinking.delta') {
        parentSink.emit(event);
      }
    },
  };
}

// ── Stale cleanup (T4.4) ──────────────────────────────────────────────

/**
 * Mark all subagent instances with status='running' as 'failed'.
 * Called during session resume to clean up subagents that were running
 * when the session was interrupted.
 *
 * Python parity: `app.py:_cleanup_stale_foreground_subagents()`
 */
export async function cleanupStaleSubagents(store: SubagentStore): Promise<string[]> {
  const instances = await store.listInstances();
  const stale = instances.filter((r) => r.status === 'running');
  const staleIds: string[] = [];
  for (const record of stale) {
    await store.updateInstance(record.agent_id, { status: 'failed' });
    staleIds.push(record.agent_id);
  }
  return staleIds;
}
