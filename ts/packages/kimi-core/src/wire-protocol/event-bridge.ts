/**
 * WireEventBridge — SoulEvent + TurnLifecycleEvent → WireEvent translator
 * (Phase 17 §A.1).
 *
 * Subscribes to two input channels (SessionEventBus + TurnLifecycleTracker)
 * and forwards translated frames through a provided transport `send`.
 * Each bridge instance owns its own `seq` counter and `currentTurnId`
 * pointer — multi-session safe (fixes the single-ref aliasing in the
 * Phase 10 test helper).
 *
 * Invariants (§5.0):
 *   - L4: listeners return `void`; the bridge never awaits `transport.send`
 *   - L5: listener does not touch wire.jsonl — translation is write-only
 *     toward the transport
 */
import { WireCodec } from './codec.js';
import { createWireEvent } from './message-factory.js';
import type {
  WireEventMethod,
  TurnBeginEventData,
  TurnEndEventData,
  StepBeginEventData,
  StepInterruptedEventData,
  ContentDeltaEventData,
  ToolCallEventData,
  ToolResultEventData,
  SessionErrorEventData,
} from './types.js';
import type { BusEvent, SessionEventBus } from '../soul-plus/session-event-bus.js';
import type {
  TurnLifecycleEvent,
  TurnLifecycleListener,
} from '../soul-plus/turn-lifecycle-tracker.js';

export interface WireEventBridgeTransport {
  send(frame: string): Promise<void>;
}

export interface InstallWireEventBridgeOptions {
  readonly server: WireEventBridgeTransport;
  readonly eventBus: SessionEventBus;
  readonly addTurnLifecycleListener: (l: TurnLifecycleListener) => () => void;
  readonly sessionId: string;
}

export interface WireEventBridgeHandle {
  dispose(): void;
}

const codec = new WireCodec();

export function installWireEventBridge(
  opts: InstallWireEventBridgeOptions,
): WireEventBridgeHandle {
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
      /* transport may have closed — swallow */
    });
  };

  const soulListener = (event: BusEvent): void => {
    switch (event.type) {
      case 'step.begin': {
        const data: StepBeginEventData = { step: event.step };
        sendWire('step.begin', data, currentTurnId);
        return;
      }
      case 'step.end': {
        const data: StepBeginEventData = { step: event.step };
        sendWire('step.end', data, currentTurnId);
        return;
      }
      case 'step.interrupted': {
        const data: StepInterruptedEventData = {
          step: event.step,
          reason: event.reason,
        };
        sendWire('step.interrupted', data, currentTurnId);
        return;
      }
      case 'content.delta': {
        const data: ContentDeltaEventData = { type: 'text', text: event.delta };
        sendWire('content.delta', data, currentTurnId);
        return;
      }
      case 'thinking.delta': {
        const data: ContentDeltaEventData = { type: 'thinking', thinking: event.delta };
        sendWire('content.delta', data, currentTurnId);
        return;
      }
      case 'tool_call_part': {
        // Phase 17 §B.6 — ride the same `content.delta` envelope so
        // clients can treat all incremental streaming (text / think /
        // tool_call_part) through one handler.
        const data: ContentDeltaEventData = {
          type: 'tool_call_part',
          tool_call_id: event.tool_call_id,
          ...(event.name !== undefined ? { name: event.name } : {}),
          ...(event.arguments_chunk !== undefined
            ? { arguments_chunk: event.arguments_chunk }
            : {}),
        };
        sendWire('content.delta', data, currentTurnId);
        return;
      }
      case 'tool.call': {
        const data: ToolCallEventData = {
          id: event.toolCallId,
          name: event.name,
          args: event.args,
        };
        sendWire('tool.call', data, currentTurnId);
        return;
      }
      case 'tool.progress': {
        sendWire(
          'tool.progress',
          { id: event.toolCallId, update: event.update },
          currentTurnId,
        );
        return;
      }
      case 'tool.result': {
        const data: ToolResultEventData = {
          tool_call_id: event.toolCallId,
          output: event.output,
          ...(event.isError !== undefined ? { is_error: event.isError } : {}),
        };
        sendWire('tool.result', data, currentTurnId);
        return;
      }
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
      case 'session.error': {
        const data: SessionErrorEventData = {
          error: event.error,
          ...(event.error_type !== undefined ? { error_type: event.error_type } : {}),
          ...(event.retry_after_ms !== undefined
            ? { retry_after_ms: event.retry_after_ms }
            : {}),
          ...(event.details !== undefined ? { details: event.details } : {}),
        };
        sendWire('session.error', data, currentTurnId);
        return;
      }
      case 'hook.triggered':
        sendWire(
          'hook.triggered',
          {
            event: event.event,
            matchers: event.matchers,
            matched_count: event.matched_count,
          },
          currentTurnId,
        );
        return;
      case 'hook.resolved':
        sendWire(
          'hook.resolved',
          { hook_id: event.hook_id, outcome: event.outcome },
          currentTurnId,
        );
        return;
      case 'status.update':
        sendWire('status.update', event.data, currentTurnId);
        return;
      default: {
        // Unknown SoulEvent variant — tolerated at runtime so future types
        // don't brick the bridge. Type-level exhaustiveness guarded by the
        // SoulEvent union.
        const _unknown: { type: string } = event;
        void _unknown;
      }
    }
  };

  const turnListener: TurnLifecycleListener = (event: TurnLifecycleEvent): void => {
    if (event.kind === 'begin') {
      currentTurnId = event.turnId;
      const data: TurnBeginEventData = {
        turn_id: event.turnId,
        user_input: event.userInputParts ?? event.userInput,
        input_kind: event.inputKind,
      };
      sendWire('turn.begin', data, event.turnId);
      return;
    }
    const turnId = event.turnId;
    const data: TurnEndEventData = {
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
    };
    sendWire('turn.end', data, turnId);
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
