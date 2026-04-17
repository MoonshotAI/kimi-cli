/**
 * Slice 4 test harness — TurnManager deps construction.
 *
 * Phase 4 拆分后 TurnManagerDeps 会新增 4 个子组件字段（compaction /
 * permissionBuilder / lifecycle required + wakeScheduler optional）。这个
 * harness 提供两类工厂：
 *
 *   - `makeTurnManagerSubcomponents(overrides?)` — 返回纯子组件 stub，
 *     由 structural typing 定义（避免 harness 物理依赖"尚未创建"的新类），
 *     可用于 compaction / permission / tracker 单组件测试互换注入。
 *
 *   - `makeTurnManagerDeps(overrides?)` — 返回完整 `TurnManagerDeps` 以
 *     及关键 collaborator refs（contextState / sessionJournal / stateMachine /
 *     subcomponents），一行构造 TurnManager 或 coordinator 级测试。
 *
 * harness 本身不 import `CompactionOrchestrator` / `PermissionClosureBuilder` /
 * `TurnLifecycleTracker` / `WakeQueueScheduler` 这四个尚未存在的新类（TS
 * 编译期 module-not-found 会把所有使用 harness 的既有测试连累成 "file
 * failed to load"）。子组件以 structural stub 形态暴露，运行期仅断言方法
 * 形状；等 Implementer 阶段落地新类 + 改写 TurnManagerDeps 之后，`as
 * unknown as TurnManagerDeps` 这层 cast 会自然消除。
 */

import { vi } from 'vitest';
import type { Mock } from 'vitest';

import type { KosongAdapter, Runtime, Tool } from '../../../src/soul/index.js';
import {
  SessionEventBus,
  SessionLifecycleStateMachine,
  SoulRegistry,
} from '../../../src/soul-plus/index.js';
import type { TurnManagerDeps } from '../../../src/soul-plus/index.js';
import { InMemoryContextState } from '../../../src/storage/context-state.js';
import type { FullContextState } from '../../../src/storage/context-state.js';
import { InMemorySessionJournalImpl } from '../../../src/storage/session-journal.js';
import type { InMemorySessionJournal } from '../../../src/storage/session-journal.js';

// ── Subcomponent stub shapes (structural typing) ─────────────────────

export interface CompactionOrchestratorStub {
  executeCompaction: Mock;
  triggerCompaction: Mock;
}

export interface WakeQueueSchedulerStub {
  enqueue: Mock;
  drain: Mock;
  isEmpty: Mock;
  peek: Mock;
}

export interface PermissionClosureBuilderStub {
  computeTurnRules: Mock;
  buildBeforeToolCall: Mock;
  buildAfterToolCall: Mock;
}

export interface TurnLifecycleTrackerStub {
  allocateTurnId: Mock;
  getCurrentTurnId: Mock;
  registerTurn: Mock;
  completeTurn: Mock;
  cancelTurn: Mock;
  awaitTurn: Mock;
  addListener: Mock;
  fireLifecycleEvent: Mock;
}

export interface TurnManagerSubcomponents {
  compaction: CompactionOrchestratorStub;
  wakeScheduler: WakeQueueSchedulerStub;
  permissionBuilder: PermissionClosureBuilderStub;
  lifecycle: TurnLifecycleTrackerStub;
}

export function makeTurnManagerSubcomponents(
  overrides: Partial<TurnManagerSubcomponents> = {},
): TurnManagerSubcomponents {
  let counter = 0;
  const compaction: CompactionOrchestratorStub = overrides.compaction ?? {
    executeCompaction: vi.fn().mockResolvedValue(undefined),
    triggerCompaction: vi.fn().mockResolvedValue(undefined),
  };
  const wakeScheduler: WakeQueueSchedulerStub = overrides.wakeScheduler ?? {
    enqueue: vi.fn(),
    drain: vi.fn().mockReturnValue([]),
    isEmpty: vi.fn().mockReturnValue(true),
    peek: vi.fn().mockReturnValue(undefined),
  };
  const permissionBuilder: PermissionClosureBuilderStub = overrides.permissionBuilder ?? {
    computeTurnRules: vi.fn().mockReturnValue([]),
    buildBeforeToolCall: vi.fn().mockReturnValue(async () => undefined),
    buildAfterToolCall: vi.fn().mockReturnValue(async () => undefined),
  };
  const lifecycle: TurnLifecycleTrackerStub = overrides.lifecycle ?? {
    allocateTurnId: vi.fn(() => {
      counter += 1;
      return `turn_${counter}`;
    }),
    getCurrentTurnId: vi.fn().mockReturnValue(undefined),
    registerTurn: vi.fn(),
    completeTurn: vi.fn(),
    cancelTurn: vi.fn().mockResolvedValue(undefined),
    awaitTurn: vi.fn().mockResolvedValue(undefined),
    addListener: vi.fn().mockReturnValue(() => undefined),
    fireLifecycleEvent: vi.fn(),
  };
  return { compaction, wakeScheduler, permissionBuilder, lifecycle };
}

// ── Stub collaborators ────────────────────────────────────────────────
//
// Phase 4 review (Nit 3): CompactionProvider / JournalCapability no longer
// flow through TurnManagerDeps — they are owned by `CompactionOrchestrator`.
// The coordinator-level harness relies on the structural `compaction`
// stub (returns undefined from executeCompaction/triggerCompaction), so
// no fallback compactionProvider/journalCapability is needed here.

function createStubKosongAdapter(): KosongAdapter {
  return {
    async chat() {
      throw new Error(
        'kosong.chat should not be reached in coordinator-level tests — supply ScriptedKosongAdapter override if you need LLM scripting',
      );
    },
  };
}

// ── Full deps factory ────────────────────────────────────────────────

export interface TurnManagerHarnessOverrides {
  contextState?: FullContextState;
  sessionJournal?: InMemorySessionJournal;
  sink?: SessionEventBus;
  lifecycleStateMachine?: SessionLifecycleStateMachine;
  soulRegistry?: SoulRegistry;
  tools?: readonly Tool[];
  runtime?: Runtime;
  kosong?: KosongAdapter;
  subcomponents?: Partial<TurnManagerSubcomponents>;
  agentId?: string;
  agentType?: 'main' | 'sub' | 'independent';
  sessionId?: string;
}

export interface TurnManagerHarness {
  deps: TurnManagerDeps;
  contextState: FullContextState;
  sessionJournal: InMemorySessionJournal;
  sink: SessionEventBus;
  stateMachine: SessionLifecycleStateMachine;
  soulRegistry: SoulRegistry;
  subcomponents: TurnManagerSubcomponents;
}

/**
 * Build the full TurnManagerDeps bag with structural subcomponent stubs.
 * Defaults are safe for coordinator-level tests (no real LLM, compaction
 * routed through the stub). Callers can override any collaborator.
 *
 * Phase 4 review (Nit 3): `TurnManagerDeps` no longer carries
 * `compactionProvider` / `journalCapability` (the CompactionOrchestrator
 * subcomponent owns them), so the harness no longer stages fallback
 * stubs for those fields and the previous `as unknown as TurnManagerDeps`
 * cast is gone — the return type now type-checks structurally.
 */
export function makeTurnManagerDeps(
  overrides: TurnManagerHarnessOverrides = {},
): TurnManagerHarness {
  const contextState =
    overrides.contextState ?? new InMemoryContextState({ initialModel: 'test-model' });
  const sessionJournal = overrides.sessionJournal ?? new InMemorySessionJournalImpl();
  const sink = overrides.sink ?? new SessionEventBus();
  const stateMachine = overrides.lifecycleStateMachine ?? new SessionLifecycleStateMachine();
  const soulRegistry =
    overrides.soulRegistry ??
    new SoulRegistry({
      createHandle: (key) => ({
        key,
        agentId: 'agent_main',
        abortController: new AbortController(),
      }),
    });
  const runtime: Runtime = overrides.runtime ?? {
    kosong: overrides.kosong ?? createStubKosongAdapter(),
  };
  const subcomponents = makeTurnManagerSubcomponents(overrides.subcomponents ?? {});

  const deps: TurnManagerDeps = {
    contextState,
    sessionJournal,
    runtime,
    sink,
    lifecycleStateMachine: stateMachine,
    soulRegistry,
    tools: overrides.tools ?? [],
    agentId: overrides.agentId ?? 'agent_main',
    agentType: overrides.agentType ?? 'main',
    sessionId: overrides.sessionId ?? 'ses_test',
    compaction: subcomponents.compaction as unknown as TurnManagerDeps['compaction'],
    wakeScheduler: subcomponents.wakeScheduler as unknown as TurnManagerDeps['wakeScheduler'],
    permissionBuilder:
      subcomponents.permissionBuilder as unknown as TurnManagerDeps['permissionBuilder'],
    lifecycle: subcomponents.lifecycle as unknown as TurnManagerDeps['lifecycle'],
  };

  return {
    deps,
    contextState,
    sessionJournal,
    sink,
    stateMachine,
    soulRegistry,
    subcomponents,
  };
}
