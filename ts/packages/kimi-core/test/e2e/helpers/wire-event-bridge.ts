/**
 * Test-local wire event bridge (Phase 10 C).
 *
 * The production in-memory harness (`createWireE2EHarness`) only handles
 * request/response round-trips — it does not forward Soul events from
 * `SessionEventBus` or turn-lifecycle events from `TurnLifecycleTracker`
 * onto the wire as `turn.begin` / `turn.end` / `step.begin` / ...
 * `content.delta` / `tool.call` / `tool.result` / `session.error` frames.
 *
 * Phase 10 treats that bridge as **test infrastructure** rather than an
 * `src/` gap: Python tests measure wire-level event ordering, and
 * rebuilding the bridge in every test is pure duplication. The real
 * `--wire` binary will own the production bridge (tracked as a Phase 11
 * deliverable); until then we attach this helper so E2E tests can assert
 * the same wire event shape Python pinned.
 *
 * Scope is deliberately narrow:
 *   - `turn.begin` / `turn.end` sourced from TurnLifecycleTracker
 *   - `step.begin` / `step.end` / `step.interrupted` / `content.delta` /
 *     `tool.call` / `tool.result` / `compaction.begin` / `compaction.end`
 *     sourced from SessionEventBus `SoulEvent`s
 *   - No `status.update` (emit path not implemented in src; Phase 11 will
 *     wire it). Tests that need it mark `it.todo`.
 *
 * NOTE: this bridge assumes a single active session per instance —
 * `currentTurnId` is a single ref, so firing listeners for two parallel
 * sessions on the same harness would alias turn ids across sessions.
 * Multi-session concurrency is out of scope for Phase 10 E2E; each test
 * allocates a fresh harness + bridge pair.
 */

import { WireCodec } from '../../../src/wire-protocol/codec.js';
import { createWireEvent } from '../../../src/wire-protocol/message-factory.js';
import type { WireEventMethod } from '../../../src/wire-protocol/types.js';
import type { BusEvent, SessionEventBus } from '../../../src/soul-plus/session-event-bus.js';
import type {
  TurnLifecycleEvent,
  TurnLifecycleListener,
} from '../../../src/soul-plus/turn-lifecycle-tracker.js';
import type { MemoryTransport } from '../../../src/transport/memory-transport.js';

export interface InstallBridgeOptions {
  readonly server: MemoryTransport;
  readonly eventBus: SessionEventBus;
  readonly addTurnLifecycleListener: (l: TurnLifecycleListener) => () => void;
  readonly sessionId: string;
}

export interface WireEventBridgeHandle {
  dispose(): void;
}

const codec = new WireCodec();

/**
 * Attach event-to-wire forwarding to the in-memory harness. Callers get
 * back a disposer that unsubscribes both channels; the harness `dispose`
 * eventually closes the transport so `send` failures after teardown are
 * swallowed here too.
 */
export function installWireEventBridge(opts: InstallBridgeOptions): WireEventBridgeHandle {
  const { server, eventBus, addTurnLifecycleListener, sessionId } = opts;
  let seq = 0;
  let currentTurnId: string | undefined;

  const sendWire = (method: WireEventMethod, data: unknown, turnId?: string): void => {
    const frame = codec.encode(
      createWireEvent({
        method,
        sessionId,
        seq: seq++,
        ...(turnId !== undefined ? { turnId } : {}),
        agentType: 'main',
        data,
      }),
    );
    void server.send(frame).catch(() => {
      /* transport may have closed — tests already finished */
    });
  };

  const soulListener = (event: BusEvent): void => {
    switch (event.type) {
      case 'step.begin':
        sendWire('step.begin', { step: event.step }, currentTurnId);
        return;
      case 'step.end':
        sendWire('step.end', { step: event.step }, currentTurnId);
        return;
      case 'step.interrupted':
        sendWire(
          'step.interrupted',
          { step: event.step, reason: event.reason },
          currentTurnId,
        );
        return;
      case 'content.delta':
        sendWire(
          'content.delta',
          { type: 'text', text: event.delta },
          currentTurnId,
        );
        return;
      case 'thinking.delta':
        sendWire(
          'content.delta',
          { type: 'thinking', thinking: event.delta },
          currentTurnId,
        );
        return;
      case 'tool.call':
        sendWire(
          'tool.call',
          { id: event.toolCallId, name: event.name, args: event.args },
          currentTurnId,
        );
        return;
      case 'tool.progress':
        sendWire(
          'tool.progress',
          { id: event.toolCallId, update: event.update },
          currentTurnId,
        );
        return;
      case 'tool.result':
        sendWire(
          'tool.result',
          {
            tool_call_id: event.toolCallId,
            output: event.output,
            ...(event.isError !== undefined ? { is_error: event.isError } : {}),
          },
          currentTurnId,
        );
        return;
      case 'compaction.begin':
        sendWire('compaction.begin', {}, currentTurnId);
        return;
      case 'compaction.end':
        sendWire(
          'compaction.end',
          {
            ...(event.tokensBefore !== undefined ? { tokens_before: event.tokensBefore } : {}),
            ...(event.tokensAfter !== undefined ? { tokens_after: event.tokensAfter } : {}),
          },
          currentTurnId,
        );
        return;
      default: {
        // NOTE: `session.error` may arrive here at runtime via
        // turn-manager's `as never` escape to sink.emit
        // (turn-manager.ts:513-517, :533-538) even though the
        // SoulEvent union doesn't list it. Phase 10 does not forward
        // it to wire — no E2E needs it yet — tracked in migration
        // report §6 P4 as a session.error → wire-event gap. We cannot
        // use `event satisfies SoulEvent` here for exhaustiveness
        // because that runtime leakage would make it fail; widen to
        // a structural shape so type-checking still confirms the
        // discriminant exists.
        const _escape: { type: string } = event;
        void _escape;
      }
    }
  };

  const turnListener: TurnLifecycleListener = (event: TurnLifecycleEvent): void => {
    if (event.kind === 'begin') {
      currentTurnId = event.turnId;
      sendWire(
        'turn.begin',
        {
          turn_id: event.turnId,
          // Phase 14 §3.5 — surface parts when present so multi-modal
          // prompts round-trip through the wire event, falling back to
          // legacy text for single-string prompts.
          user_input: event.userInputParts ?? event.userInput,
          input_kind: event.inputKind,
        },
        event.turnId,
      );
      return;
    }
    const turnId = event.turnId;
    sendWire(
      'turn.end',
      {
        turn_id: turnId,
        reason: event.reason,
        success: event.success,
        ...(event.usage !== undefined
          ? {
              usage: {
                input_tokens: event.usage.input,
                output_tokens: event.usage.output,
                ...(event.usage.cache_read !== undefined
                  ? { cache_read_tokens: event.usage.cache_read }
                  : {}),
                ...(event.usage.cache_write !== undefined
                  ? { cache_write_tokens: event.usage.cache_write }
                  : {}),
              },
            }
          : {}),
      },
      turnId,
    );
    if (currentTurnId === turnId) {
      currentTurnId = undefined;
    }
  };

  const unsubTurn = addTurnLifecycleListener(turnListener);

  eventBus.on(soulListener);

  return {
    dispose(): void {
      eventBus.off(soulListener);
      unsubTurn();
    },
  };
}
