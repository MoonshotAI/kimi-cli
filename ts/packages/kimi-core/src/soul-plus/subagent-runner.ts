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
 *
 * Phase 6 (决策 #88 / §3.6.1 / §6.5):
 *   - Each subagent now has its OWN `wire.jsonl` at
 *     `sessions/<session>/subagents/<agent_id>/wire.jsonl`. The runner
 *     creates a `WiredContextState` + `WiredJournalWriter` per child;
 *     conversation records live entirely on the child's wire.
 *   - The child's `EventSink` is a `createSubagentSinkWrapper` that
 *     forwards every event to the parent `SessionEventBus` with a
 *     `source` envelope. The wrapper itself does not persist anything;
 *     the child wire is written by `ContextState.appendXxx()` directly.
 *   - When `parentSessionJournal` is supplied in deps, the runner writes
 *     the three lifecycle records (`subagent_spawned` /
 *     `subagent_completed` / `subagent_failed`) on the parent journal so
 *     the parent wire carries lifecycle references but never the child's
 *     conversation payload (decision #88 — replaces the old
 *     `subagent_event` nesting). In the production path SoulRegistry
 *     owns the lifecycle write (it writes them around the
 *     `runSubagentTurn` call), so the runner's parentSessionJournal
 *     branch is exercised by direct-runner tests only.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { PathConfig } from '../session/path-config.js';
import { runSoulTurn } from '../soul/index.js';
import type { EventSink, Runtime, SoulConfig, Tool } from '../soul/index.js';
import type { SoulEvent } from '../soul/event-sink.js';
import { InMemoryContextState, WiredContextState } from '../storage/context-state.js';
import {
  WiredJournalWriter,
  type LifecycleGate,
  type LifecycleState,
} from '../storage/journal-writer.js';
import type { SessionJournal } from '../storage/session-journal.js';
import type { AgentResult, SpawnRequest } from './subagent-types.js';
import type { AgentTypeRegistry } from './agent-type-registry.js';
import { collectGitContext } from './git-context.js';
import type { SessionEventBus, EventSource } from './session-event-bus.js';
import { RESULT_SUMMARY_MAX_LEN } from './subagent-constants.js';
import { createSubagentSinkWrapper } from './subagent-sink-wrapper.js';
import type { SubagentStore } from './subagent-store.js';

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
  /**
   * Filesystem root for the parent session. When `pathConfig` +
   * `sessionId` are also supplied, the runner derives the child wire
   * path through `pathConfig.subagentDir(sessionId, agentId)` instead;
   * `sessionDir` is the explicit fallback for tests / SDK embedders that
   * don't construct a `PathConfig`. Pass `''` to skip on-disk wire
   * persistence entirely (in-memory child context only).
   */
  readonly sessionDir: string;
  /** Model name to use for child context (parent's current model). */
  readonly parentModel: string;
  /**
   * Working directory for git context injection (explore agents).
   * When absent, defaults to `process.cwd()`.
   */
  readonly workDir?: string | undefined;
  /**
   * Phase 6 — preferred channel. The runner constructs a
   * `createSubagentSinkWrapper` against this bus so child events fan out
   * with a `source` envelope.
   */
  readonly parentEventBus?: SessionEventBus | undefined;
  /**
   * Phase 6 — when supplied, the runner writes the three lifecycle
   * records (spawned / completed / failed) on the parent SessionJournal.
   *
   * **Production path: leave this undefined.** `SoulRegistry.spawn()`
   * owns the lifecycle write so runner / registry responsibilities stay
   * decoupled (铁律 7). `SoulPlus` deliberately omits this field when
   * building the runner deps, and Registry's `parentSessionJournal`
   * channel writes the spawned/completed/failed records around the
   * runner call. Passing `parentSessionJournal` here while ALSO routing
   * through `SoulRegistry.spawn()` causes double-writes.
   *
   * **Test-only path: provide this** when calling `runSubagentTurn`
   * directly (i.e. NOT via `SoulRegistry.spawn()`) so the runner can
   * verify the lifecycle contract end-to-end. Direct-runner tests
   * (`subagent-independent-wire.test.ts`) take this path; they MUST
   * NOT also instantiate a `SoulRegistry` for the same agent.
   */
  readonly parentSessionJournal?: SessionJournal | undefined;
  /**
   * Phase 6 — optional `PathConfig` source for the child wire path.
   * When provided together with `sessionId`, the runner derives
   * `pathConfig.subagentDir(sessionId, agentId)` instead of joining
   * `sessionDir` by hand. Production wiring (`soul-plus.ts`) passes
   * this so the wire layout follows the §9.5 path service; tests that
   * mint a temp dir and pass `sessionDir` directly continue to work.
   */
  readonly pathConfig?: PathConfig | undefined;
  /**
   * Phase 6 — session id for `PathConfig.subagentDir(sessionId, …)`.
   * Required iff `pathConfig` is supplied; ignored otherwise.
   */
  readonly sessionId?: string | undefined;
}

class StubChildLifecycle implements LifecycleGate {
  state: LifecycleState = 'active';
}

// ── runSubagentTurn ───────────────────────────────────────────────────

/**
 * Execute a single subagent turn. This is the callback wired into
 * `SoulRegistry.runSubagentTurn`.
 */
export async function runSubagentTurn(
  deps: SubagentRunnerDeps,
  agentId: string,
  request: SpawnRequest,
  signal: AbortSignal,
): Promise<AgentResult> {
  const {
    store,
    typeRegistry,
    parentTools,
    parentRuntime,
    parentEventBus,
    parentSessionJournal,
    parentModel,
    sessionDir,
    pathConfig,
    sessionId,
  } = deps;

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

  // Phase 6 — write the spawned lifecycle record on the parent journal
  // BEFORE any further setup so the parent wire records the spawn even
  // when child setup fails downstream.
  //
  // ⚠ Double-write guard: this branch fires ONLY when the runner is
  // invoked directly (test-only path; see `parentSessionJournal` JSDoc
  // on `SubagentRunnerDeps`). The production path goes through
  // `SoulRegistry.spawn()`, which handles the lifecycle write itself
  // and intentionally omits `parentSessionJournal` from the runner
  // deps. Both writers active at once would double the spawned /
  // completed / failed records on the parent wire.
  if (parentSessionJournal !== undefined) {
    await parentSessionJournal.appendSubagentSpawned({
      type: 'subagent_spawned',
      data: {
        agent_id: agentId,
        ...(request.agentName !== undefined ? { agent_name: request.agentName } : {}),
        parent_tool_call_id: request.parentToolCallId,
        ...(request.parentAgentId !== undefined &&
        request.parentAgentId !== '' &&
        request.parentAgentId !== 'agent_main'
          ? { parent_agent_id: request.parentAgentId }
          : {}),
        run_in_background: request.runInBackground ?? false,
      },
    });
  }

  // 3. Create child infrastructure

  // Build system prompt for child. Since Slice 6.0, loadSubagentTypes()
  // reads system_prompt_path (system.md) and renders the full template
  // with nunjucks, so systemPromptSuffix now contains the complete
  // system prompt (base + ROLE_ADDITIONAL), not just the suffix.
  const childSystemPrompt = typeDef.systemPromptSuffix || undefined;

  // Determine child model: request override > type default > parent model
  const childModel = request.model ?? typeDef.defaultModel ?? parentModel;

  // Phase 6 — child context backed by an independent on-disk wire.jsonl.
  // Path derivation follows a two-tier fallback:
  //   1. If `pathConfig` + `sessionId` are provided (production wiring
  //      via SoulPlus), use `pathConfig.subagentDir(sessionId, agentId)`
  //      so the layout honours the §9.5 path service.
  //   2. Otherwise fall back to `join(sessionDir, 'subagents', agentId)`
  //      for tests / SDK embedders that pass a temp dir directly.
  // When `sessionDir` is `''` and no `pathConfig` is supplied we skip
  // on-disk persistence and build an in-memory child context instead.
  let childContext: InMemoryContextState | WiredContextState;
  let childJournalWriter: WiredJournalWriter | undefined;
  const canPersistChildWire =
    (pathConfig !== undefined && sessionId !== undefined) || sessionDir !== '';
  if (canPersistChildWire) {
    const subagentDir =
      pathConfig !== undefined && sessionId !== undefined
        ? pathConfig.subagentDir(sessionId, agentId)
        : join(sessionDir, 'subagents', agentId);
    await mkdir(subagentDir, { recursive: true });
    const childLifecycle = new StubChildLifecycle();
    childJournalWriter = new WiredJournalWriter({
      filePath: join(subagentDir, 'wire.jsonl'),
      lifecycle: childLifecycle,
      // Per-record fsync so direct-runner tests can read wire.jsonl
      // immediately after `await runSubagentTurn(...)` without waiting
      // for the batched drain timer.
      config: { fsyncMode: 'per-record' },
    });
    childContext = new WiredContextState({
      journalWriter: childJournalWriter,
      initialModel: childModel,
      ...(childSystemPrompt !== undefined ? { initialSystemPrompt: childSystemPrompt } : {}),
      currentTurnId: () => `${agentId}_turn`,
    });
  } else {
    childContext = new InMemoryContextState({
      initialModel: childModel,
      ...(childSystemPrompt !== undefined ? { initialSystemPrompt: childSystemPrompt } : {}),
    });
  }

  // Phase 2: Runtime narrowed to `{kosong}`. Subagents never compact
  // (their history is ephemeral and discarded on agent_end), so the
  // parent's compactionProvider / lifecycle / journal don't need to
  // flow through — compaction infra is wired via TurnManagerDeps on the
  // parent's TurnManager, not on Soul-level Runtime.
  const childRuntime: Runtime = {
    kosong: parentRuntime.kosong,
  };

  // Build the child sink. When `parentEventBus` is supplied (Phase 6
  // production path) the wrapper fans events out with a `source`
  // envelope; otherwise the child runs with a noop sink (e.g. in-memory
  // embedders that only care about the `AgentResult`). The outer
  // contentCollector layer captures content deltas for summary
  // continuation regardless of which base sink is in play.
  const contentCollector: string[] = [];
  let baseSink: EventSink;
  if (parentEventBus !== undefined && childJournalWriter !== undefined) {
    const source: EventSource = {
      id: agentId,
      kind: 'subagent',
      parent_tool_call_id: request.parentToolCallId,
      ...(request.agentName !== undefined ? { name: request.agentName } : {}),
    };
    baseSink = createSubagentSinkWrapper({
      childJournalWriter,
      parentEventBus,
      source,
    });
  } else {
    baseSink = { emit: () => {} };
  }
  const childSink: EventSink = {
    emit(event: SoulEvent): void {
      if (event.type === 'content.delta') {
        contentCollector.push(event.delta);
      }
      baseSink.emit(event);
    },
  };

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

  let resultText = '';
  let usage = { input: 0, output: 0 };
  try {
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
    resultText = contentCollector.join('');
    usage = turnResult.usage;

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
  } catch (error) {
    // Phase 6 — write the failure record to the parent journal before
    // re-throwing. The catch sits OUTSIDE the inner try so it covers
    // setup throws as well as soul-turn throws.
    if (parentSessionJournal !== undefined) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await parentSessionJournal
        .appendSubagentFailed({
          type: 'subagent_failed',
          data: {
            agent_id: agentId,
            parent_tool_call_id: request.parentToolCallId,
            error: errorMessage,
          },
        })
        // Never let the parent-journal write itself mask the original
        // failure — log paths upstream are responsible for surfacing
        // journal errors.
        .catch(() => {});
    }
    if (childJournalWriter !== undefined) {
      // Make the child wire's tail durable even on the error path so a
      // subsequent inspector / replay sees what the child got through.
      await childJournalWriter.close().catch(() => {});
    }
    throw error;
  }

  // Flush + close the child wire so the test (and any downstream
  // consumer) can read the file immediately after `await`. Per-record
  // fsync mode means individual writes are already on disk; close()
  // additionally stops the drain timer.
  if (childJournalWriter !== undefined) {
    await childJournalWriter.close();
  }

  if (parentSessionJournal !== undefined) {
    const summary = resultText.length > 0
      ? resultText.substring(0, RESULT_SUMMARY_MAX_LEN)
      : '';
    await parentSessionJournal.appendSubagentCompleted({
      type: 'subagent_completed',
      data: {
        agent_id: agentId,
        parent_tool_call_id: request.parentToolCallId,
        result_summary: summary,
        usage,
      },
    });
  }

  return { result: resultText, usage };
}

// ── Stale cleanup (T4.4) ──────────────────────────────────────────────

/**
 * Mark all subagent instances with status='running' as 'lost'.
 * Called during session resume to clean up subagents that were running
 * when the session was interrupted.
 *
 * Per v2 §8.2: residual running records become 'lost', NOT 'failed' —
 * 'failed' is reserved for subagents that hit a runtime error during
 * their own turn (caught by `runSubagentTurn`'s inner try/catch). 'lost'
 * semantically captures "was running when the parent process died, final
 * outcome unknown".
 *
 * Python parity: `app.py:_cleanup_stale_foreground_subagents()` writes
 * `'failed'` in Python; TS intentionally diverges here to track v2.
 */
export async function cleanupStaleSubagents(store: SubagentStore): Promise<string[]> {
  const instances = await store.listInstances();
  const stale = instances.filter((r) => r.status === 'running');
  const staleIds: string[] = [];
  for (const record of stale) {
    await store.updateInstance(record.agent_id, { status: 'lost' });
    staleIds.push(record.agent_id);
  }
  return staleIds;
}
