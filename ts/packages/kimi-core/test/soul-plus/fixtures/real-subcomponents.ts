/**
 * Phase 4 helper — construct REAL `CompactionOrchestrator` /
 * `PermissionClosureBuilder` / `TurnLifecycleTracker` /
 * `WakeQueueScheduler` instances wired to the same collaborators an
 * existing turn-manager test already builds.
 *
 * `makeTurnManagerDeps` (fixtures/turn-manager-harness.ts) hands back
 * *stub* subcomponents so coordinator-level tests can assert on the
 * delegation boundary. The pre-Phase-4 TurnManager tests (turn-manager-
 * prompt / -cancel / -steer / -compaction-loop / -lifecycle-observer /
 * -agent-id / turn-override / slice3.6-integration / orchestrator
 * integration) exercise TurnManager with real collaborators — they
 * need real subcomponents so the exercised code path remains
 * behaviour-equivalent. This helper bridges the two worlds.
 *
 * Required inputs are the fields the ORIGINAL subcomponents used to
 * pull off of `TurnManagerDeps` directly (contextState,
 * compactionProvider, lifecycleStateMachine, journalCapability, sink,
 * orchestrator?). Missing optional fields fall back to the stubs
 * already in the slice3 harness.
 */

import type { CompactionProvider, JournalCapability } from '../../../src/soul/index.js';
import {
  CompactionOrchestrator,
  STATIC_DEFAULT_RUNTIME_STATE,
  STATIC_NO_PENDING_TURN,
} from '../../../src/soul-plus/compaction-orchestrator.js';
import type { SessionLifecycleStateMachine } from '../../../src/soul-plus/lifecycle-state-machine.js';
import type { ToolCallOrchestrator } from '../../../src/soul-plus/orchestrator.js';
import { PermissionClosureBuilder } from '../../../src/soul-plus/permission-closure-builder.js';
import type { SessionEventBus } from '../../../src/soul-plus/session-event-bus.js';
import { TurnLifecycleTracker } from '../../../src/soul-plus/turn-lifecycle-tracker.js';
import { WakeQueueScheduler } from '../../../src/soul-plus/wake-queue-scheduler.js';
import type { FullContextState } from '../../../src/storage/context-state.js';
import {
  createNoopCompactionProvider,
  createNoopJournalCapability,
} from './slice3-harness.js';

export interface RealSubcomponentsInput {
  readonly contextState: FullContextState;
  readonly lifecycleStateMachine: SessionLifecycleStateMachine;
  readonly sink: SessionEventBus;
  readonly compactionProvider?: CompactionProvider | undefined;
  readonly journalCapability?: JournalCapability | undefined;
  readonly orchestrator?: ToolCallOrchestrator | undefined;
  readonly sessionId?: string | undefined;
  readonly agentId?: string | undefined;
}

export interface RealSubcomponents {
  readonly compaction: CompactionOrchestrator;
  readonly permissionBuilder: PermissionClosureBuilder;
  readonly lifecycle: TurnLifecycleTracker;
  readonly wakeScheduler: WakeQueueScheduler;
}

export function makeRealSubcomponents(input: RealSubcomponentsInput): RealSubcomponents {
  const compaction = new CompactionOrchestrator({
    contextState: input.contextState,
    compactionProvider: input.compactionProvider ?? createNoopCompactionProvider(),
    lifecycleStateMachine: input.lifecycleStateMachine,
    journalCapability: input.journalCapability ?? createNoopJournalCapability(),
    sink: input.sink,
    journalWriter: input.contextState.journalWriter,
    runtimeStateProvider: STATIC_DEFAULT_RUNTIME_STATE,
    getPendingTurnId: STATIC_NO_PENDING_TURN,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
  });
  const permissionBuilder = new PermissionClosureBuilder({
    ...(input.orchestrator !== undefined ? { orchestrator: input.orchestrator } : {}),
  });
  const lifecycle = new TurnLifecycleTracker();
  const wakeScheduler = new WakeQueueScheduler();
  return { compaction, permissionBuilder, lifecycle, wakeScheduler };
}
