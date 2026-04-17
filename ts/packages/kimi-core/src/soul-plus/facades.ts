/**
 * SoulPlus facade interfaces (v2 §5.2 / 决策 #92).
 *
 * Phase 4 aggregates SoulPlus's 25 private fields into 6 facade groups
 * so the session object is easier to reason about: five narrow
 * `*Facade` views (lifecycle / journal / services / components /
 * infra), plus `runtime` kept as an independent top-level field because
 * Soul consumes it directly (铁律 6 — Runtime is Soul's *only* SoulPlus-
 * visible contract surface).
 *
 * The facades are plain `interface` + plain object wiring — no runtime
 * overhead. Construction is a six-phase 1:1 assembly inside the
 * SoulPlus constructor; each facade field points at the same physical
 * instance the pre-Phase-4 flat field pointed at, so component deps
 * interfaces (TurnManagerDeps etc.) are untouched.
 */

import type { HookEngine } from '../hooks/engine.js';
import type { JournalCapability, Tool } from '../soul/index.js';
import type { FullContextState } from '../storage/context-state.js';
import type { JournalWriter } from '../storage/journal-writer.js';
import type { SessionJournal } from '../storage/session-journal.js';
import type { ApprovalRuntime } from './approval-runtime.js';
import type { CompactionOrchestrator } from './compaction-orchestrator.js';
import type { SessionLifecycleStateMachine } from './lifecycle-state-machine.js';
import type { NotificationManager } from './notification-manager.js';
import type { ToolCallOrchestrator } from './orchestrator.js';
import type { PermissionClosureBuilder } from './permission-closure-builder.js';
import type { PermissionRule } from './permission/index.js';
import type { SessionEventBus } from './session-event-bus.js';
import type { SessionMetaService } from './session-meta-service.js';
import type { SkillManager } from './skill/index.js';
import type { SoulLifecycleGate } from './soul-lifecycle-gate.js';
import type { SoulRegistry } from './soul-registry.js';
import type { TurnLifecycleTracker } from './turn-lifecycle-tracker.js';
import type { TurnManager } from './turn-manager.js';
import type { WakeQueueScheduler } from './wake-queue-scheduler.js';

/**
 * Lifecycle facade — canonical 5-state machine plus the Soul-facing
 * 3-state gate.
 */
export interface LifecycleFacade {
  readonly stateMachine: SessionLifecycleStateMachine;
  readonly gate: SoulLifecycleGate;
}

/**
 * Journal facade — everything that persists conversation / management
 * records to disk or in-memory equivalents.
 */
export interface JournalFacade {
  readonly writer: JournalWriter;
  readonly contextState: FullContextState;
  readonly sessionJournal: SessionJournal;
  readonly capability: JournalCapability | undefined;
}

/**
 * Services facade — pure service objects that TurnManager / other
 * components orchestrate but never own.
 */
export interface ServicesFacade {
  readonly orchestrator: ToolCallOrchestrator | undefined;
  readonly approvalRuntime: ApprovalRuntime | undefined;
  readonly compaction: CompactionOrchestrator;
  readonly permissionBuilder: PermissionClosureBuilder;
  /**
   * Phase 16 / 决策 #113 — sessionMeta single-truth facade. Undefined
   * when the host did not supply `stateCache` + `initialMeta` through
   * SoulPlusDeps (test harnesses that skip the SessionManager path).
   */
  readonly sessionMeta: SessionMetaService | undefined;
}

/**
 * Components facade — stateful coordinators / registries backing the
 * conversation loop.
 */
export interface ComponentsFacade {
  readonly turnManager: TurnManager;
  readonly soulRegistry: SoulRegistry;
  readonly skillManager: SkillManager | undefined;
  readonly notificationManager: NotificationManager;
  readonly wakeScheduler: WakeQueueScheduler;
  readonly turnLifecycle: TurnLifecycleTracker;
}

/**
 * Infra facade — shared infrastructure (buses, registries, static rule
 * set) not tied to any one component.
 */
export interface InfraFacade {
  readonly eventBus: SessionEventBus;
  readonly toolRegistry: readonly Tool[];
  readonly permissionRules: readonly PermissionRule[];
  readonly hookEngine: HookEngine | undefined;
}
