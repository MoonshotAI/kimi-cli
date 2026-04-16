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
import type { SubagentStore } from './subagent-store.js';
import {
  SubagentRuntimeLifecycleGate,
  SUBAGENT_JOURNAL_CAPABILITY,
} from './subagent-lifecycle-gate.js';

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

  // Build system prompt for child (inject ROLE_ADDITIONAL suffix).
  // Note: Python also reads system_prompt_path (e.g. system.md) as the
  // base prompt. In 5.3 we only use the ROLE_ADDITIONAL suffix — the full
  // system prompt file loading is deferred to a future slice.
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

  // 5. Run the Soul turn
  let turnResult;
  try {
    turnResult = await runSoulTurn(
      { text: request.prompt },
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
  const resultText = contentCollector.join('');
  const usage = turnResult.usage;

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
