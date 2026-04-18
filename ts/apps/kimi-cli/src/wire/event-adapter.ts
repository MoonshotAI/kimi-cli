/**
 * Soul → Wire event adapter (Slice 4.1).
 *
 * kimi-core emits `SoulEvent`s via `SessionEventBus` — a narrow union that
 * covers `step.*`, `content.delta`, `tool.*`, and `compaction.*`. The TUI
 * consumes the richer `WireMessage` envelope with event data shapes from
 * `./events.ts`. This adapter is a pure function mapping one to the other
 * so the `KimiCoreClient` bridge stays thin.
 *
 * SoulEvent does NOT carry `turn.begin` or `turn.end` — those are
 * synthesised from lifecycle observer events in `kimi-core-client.ts`.
 * `tool.result` is first-class as of Slice 4.2. Events without a TUI
 * counterpart map to `null` and are skipped.
 */

import type { SoulEvent } from '@moonshot-ai/core';

import { createEvent } from './wire-message.js';
import type { WireMessage } from './wire-message.js';

export interface EventAdaptContext {
  readonly sessionId: string;
  readonly turnId: string | undefined;
  readonly nextSeq: () => number;
}

export function adaptSoulEventToWireMessage(
  event: SoulEvent,
  ctx: EventAdaptContext,
): WireMessage | null {
  const common = {
    session_id: ctx.sessionId,
    ...(ctx.turnId !== undefined ? { turn_id: ctx.turnId } : {}),
    seq: ctx.nextSeq(),
  };

  switch (event.type) {
    case 'step.begin':
      return createEvent('step.begin', { step: event.step }, common);

    case 'step.end':
      return createEvent('step.end', {}, common);

    case 'step.interrupted':
      return createEvent('step.interrupted', { step: event.step, reason: event.reason }, common);

    case 'content.delta':
      // SoulEvent `content.delta` carries raw `delta: string` with no
      // discriminator. The kosong adapter only forwards assistant text
      // parts through `onDelta`, so all deltas are text (thinking deltas
      // are absorbed inside the adapter and emitted separately — see
      // Slice 2.1). Map to the TUI `{type:'text', text}` shape.
      return createEvent('content.delta', { type: 'text', text: event.delta }, common);

    case 'thinking.delta':
      // Thinking deltas flow through their own wire event so the TUI
      // renders them in the dedicated ThinkingBlock rather than the
      // main assistant text stream.
      return createEvent('content.delta', { type: 'think', think: event.delta }, common);

    case 'tool.call':
      return createEvent(
        'tool.call',
        { id: event.toolCallId, name: event.name, args: event.args },
        common,
      );

    case 'tool.progress':
      return createEvent(
        'tool.progress',
        { tool_call_id: event.toolCallId, update: event.update },
        common,
      );

    case 'tool.result':
      // Slice 4.2 — runSoulTurn emits `tool.result` SoulEvents at every
      // `appendToolResult` call site (normal + synthetic paths). The
      // bridge just forwards them verbatim; the per-tool wrapper that
      // Slice 4.1 used in KimiCoreClient is deleted.
      return createEvent(
        'tool.result',
        {
          tool_call_id: event.toolCallId,
          output: event.output,
          ...(event.isError === true ? { is_error: true } : {}),
        },
        common,
      );

    case 'compaction.begin':
      return createEvent('compaction.begin', {}, common);

    case 'compaction.end':
      return createEvent(
        'compaction.end',
        {
          ...(event.tokensBefore !== undefined ? { tokens_before: event.tokensBefore } : {}),
          ...(event.tokensAfter !== undefined ? { tokens_after: event.tokensAfter } : {}),
        },
        common,
      );

    case 'session_meta.changed':
      return createEvent(
        'session_meta.changed',
        { patch: event.data.patch, source: event.data.source },
        common,
      );

    case 'turn.end':
    case 'model.changed':
      // Phase 16 — these SoulEvent variants are consumed by SessionMetaService
      // for derived-field accounting; the TUI receives its own turn.end /
      // model.changed notifications through the Soul-side turn lifecycle
      // and config-change pipes, so skip them here to avoid double-delivery.
      return null;

    // Phase 17 §A.6 / §A.2 / §B.7 — new SoulEvent variants. The TUI
    // bridge forwards session.error + status.update as wire events;
    // hook.triggered / hook.resolved drop through until a dedicated
    // hook-observability widget lands (CLI Phase).
    case 'session.error':
      return createEvent(
        'session.error',
        {
          error: event.error,
          ...(event.error_type !== undefined ? { error_type: event.error_type } : {}),
          ...(event.retry_after_ms !== undefined
            ? { retry_after_ms: event.retry_after_ms }
            : {}),
          ...(event.details !== undefined ? { details: event.details } : {}),
        },
        common,
      );

    case 'status.update':
      return createEvent('status.update', event.data, common);

    // Phase 21 §A — typed thinking-level change. The wire bridge owns the
    // per-session `seq`; this adapter just forwards the level on the
    // dedicated `thinking.changed` channel so CLI renderers can update
    // their indicator without subscribing to the full status snapshot.
    case 'thinking.changed':
      return createEvent('thinking.changed', { level: event.level }, common);

    case 'hook.triggered':
    case 'hook.resolved':
      return null;

    // Phase 17 §B.6 — forwarded on the same `content.delta` envelope
    // so TUI renderers can thread text / think / tool_call_part
    // through one handler.
    case 'tool_call_part':
      return createEvent(
        'content.delta',
        {
          type: 'tool_call_part',
          tool_call_id: event.tool_call_id,
          ...(event.name !== undefined ? { name: event.name } : {}),
          ...(event.arguments_chunk !== undefined
            ? { arguments_chunk: event.arguments_chunk }
            : {}),
        },
        common,
      );


    default: {
      // Exhaustive guard — adding a new SoulEvent variant without
      // extending this switch is a compile error.
      const _exhaustive: never = event;
      void _exhaustive;
      return null;
    }
  }
}
