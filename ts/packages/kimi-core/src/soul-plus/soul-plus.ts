/**
 * SoulPlus — the session facade (v2 §5.2).
 *
 * Slice 3 scope: a thin wrapper that assembles the shared resource layer
 * (SessionLifecycleStateMachine / LifecycleGateFacade / JournalWriter /
 * WiredContextState / SessionJournal), the service layer (KosongAdapter /
 * Runtime), and a reduced behaviour layer (TurnManager / SoulRegistry /
 * SessionEventBus). `dispatch(req)` is the single entry point and, for
 * Slice 3, only routes the three conversation-channel methods
 * (`session.prompt` / `session.cancel` / `session.steer`). Anything else
 * returns `{ error: "method_not_found" }`.
 *
 * Out of scope for Slice 3:
 *   - RequestRouter / ownership checks (Slice 5)
 *   - NotificationManager (Slice 8)
 *   - SkillManager (Slice 9A)
 *   - TeamDaemon (Slice 7+)
 *   - ToolCallOrchestrator (Slice 4)
 *   - Real wire protocol envelope (Slice 5)
 */

import type { EventSink, Runtime, Tool } from '../soul/index.js';
import type { FullContextState } from '../storage/context-state.js';
import type { SessionJournal } from '../storage/session-journal.js';
import { LifecycleGateFacade } from './lifecycle-gate.js';
import { SessionLifecycleStateMachine } from './lifecycle-state-machine.js';
import { SoulRegistry } from './soul-registry.js';
import { TurnManager } from './turn-manager.js';
import type { DispatchRequest, DispatchResponse } from './types.js';

export interface SoulPlusDeps {
  readonly sessionId: string;
  readonly contextState: FullContextState;
  readonly sessionJournal: SessionJournal;
  readonly runtime: Runtime;
  readonly eventBus: EventSink;
  readonly tools: readonly Tool[];
}

export class SoulPlus {
  public readonly sessionId: string;
  private readonly turnManager: TurnManager;

  constructor(deps: SoulPlusDeps) {
    this.sessionId = deps.sessionId;

    // Slice 3 construction:
    //   1. Build a local SessionLifecycleStateMachine (the one physical
    //      state machine for this session).
    //   2. Wrap it in a LifecycleGateFacade — the facade is what
    //      `Runtime.lifecycle` / `JournalWriter.lifecycle` consume.
    //   3. Rebuild `runtime` with `lifecycle: facade` so Soul (via
    //      `runtime.lifecycle.transitionTo`) and TurnManager (via
    //      `lifecycleStateMachine.transitionTo`) drive the SAME physical
    //      state machine. This avoids the desync trap the Round 1 review
    //      flagged: without this rewiring, Soul's compaction path would
    //      mutate the caller's state machine while TurnManager mutated
    //      an independent local one, and the two would diverge.
    //
    // Slice 5 RequestRouter will lift state machine ownership one level
    // up to SessionManager and pass it in via deps; at that point this
    // local construction disappears.
    const stateMachine = new SessionLifecycleStateMachine();
    const facade = new LifecycleGateFacade(stateMachine);
    const runtime: Runtime = {
      kosong: deps.runtime.kosong,
      compactionProvider: deps.runtime.compactionProvider,
      lifecycle: facade,
      journal: deps.runtime.journal,
    };

    const soulRegistry = new SoulRegistry({
      createHandle: (key) => ({
        key,
        agentId: 'agent_main',
        abortController: new AbortController(),
      }),
    });

    this.turnManager = new TurnManager({
      contextState: deps.contextState,
      sessionJournal: deps.sessionJournal,
      runtime,
      sink: deps.eventBus,
      lifecycleStateMachine: stateMachine,
      soulRegistry,
      tools: deps.tools,
    });
  }

  async dispatch(request: DispatchRequest): Promise<DispatchResponse> {
    switch (request.method) {
      case 'session.prompt':
        return this.turnManager.handlePrompt({ data: request.data });
      case 'session.cancel':
        return this.turnManager.handleCancel({ data: request.data });
      case 'session.steer':
        return this.turnManager.handleSteer({ data: request.data });
      default: {
        // Exhaustive guard — Slice 5 must extend `DispatchRequest` AND
        // add a matching case here; if it forgets, this line fails to
        // compile instead of silently returning `method_not_found`.
        const _exhaustive: never = request;
        void _exhaustive;
        return { error: 'method_not_found' };
      }
    }
  }
}
