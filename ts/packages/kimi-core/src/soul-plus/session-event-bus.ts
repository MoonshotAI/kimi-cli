/**
 * SessionEventBus — session-wide fan-out for Soul events (v2 §4.6 / §5.2).
 *
 * Two faces:
 *   1. Inward (to Soul): implements Slice 2 `EventSink` — `emit(event)`
 *      returns `void`, not `Promise<void>` (铁律 4). Soul calls it
 *      synchronously from inside `runSoulTurn`.
 *   2. Outward (to UI / transport / telemetry): `on(listener)` registers a
 *      sink, `off(listener)` removes it. Listeners also see `void` from
 *      `emit` — they have no way to back-pressure Soul.
 *
 * Contract guarantees (v2 §4.6.3):
 *   - Listener errors must NOT propagate back to Soul. The bus catches them
 *     internally — both synchronous `throw` and any rejected `Promise`
 *     returned by an `async` listener — so a bad UI listener cannot crash
 *     the agent loop or surface as an unhandled rejection at the Node
 *     process level. Slice 3 audit M3 (parallels Slice 2 `safeEmit`).
 *   - Listeners MUST NOT call back into `ContextState` write methods or
 *     `JournalWriter.append` (铁律 5). Enforcement is convention-level.
 *   - `emit` fans out synchronously in listener registration order. Async
 *     listeners are dispatched fire-and-forget — the bus does NOT await
 *     them (铁律 4: Soul cannot be back-pressured).
 */

import type { EventSink, SoulEvent } from '../soul/index.js';
import type { NotificationData } from './notification-manager.js';

// ── Source-tagged transport envelope (Phase 6 / 决策 #88 / §4.8.2) ────
//
// `source` lives ONLY in the EventBus transport layer. It MUST NEVER be
// persisted to wire.jsonl (铁律 5). Subagent / teammate Souls emit plain
// `SoulEvent`s; the SinkWrapper attaches a `source` envelope through
// `emitWithSource` so listeners can attribute the event back to the
// originating agent without touching the persistence layer.

export interface EventSource {
  /** Stable id of the originating agent (e.g. `sub_<uuid>`, `agent_main`). */
  id: string;
  kind: 'subagent' | 'teammate' | 'remote';
  /** Optional human-readable name (e.g. agent type, teammate handle). */
  name?: string;
  /**
   * The parent tool call that spawned this source (subagent path only).
   * Host UIs use this to graft child events onto the parent tool call's
   * block. Transport-only — like the rest of `EventSource`, it never
   * reaches wire.jsonl.
   */
  parent_tool_call_id?: string;
}

/**
 * Transport-layer envelope: a `SoulEvent` plus the optional `source`
 * attribution. Main-agent emissions reach listeners with `source ===
 * undefined`; subagent / teammate emissions reach listeners with the
 * tag attached. Soul itself never sees this type — it's the EventBus's
 * outward face only.
 */
export type BusEvent = SoulEvent & { source?: EventSource };

/**
 * Listener signature. `void | Promise<void>` (rather than bare `void`) so
 * callers can legitimately write `async` listeners — the bus will isolate
 * any rejected promise via a terminal `.catch` attached inside `emit`.
 */
export type SessionEventListener = (event: BusEvent) => void | Promise<void>;

/**
 * Notification listener signature (Slice 2.4). Same async-safe shape as
 * `SessionEventListener`; rejections are isolated by the bus.
 */
export type NotificationListener = (notif: NotificationData) => void | Promise<void>;

export class SessionEventBus implements EventSink {
  private readonly listeners: SessionEventListener[] = [];
  private readonly notificationListeners: NotificationListener[] = [];

  emit(event: SoulEvent): void {
    // Iterate over a stable snapshot so a listener that mutates the bus
    // cannot shift the iteration it is part of. Main-agent emissions
    // reach listeners with `source === undefined` — the BusEvent shape is
    // a structural superset of SoulEvent so this is type-safe.
    const snapshot = this.listeners.slice();
    for (const listener of snapshot) {
      safeDispatch(listener, event as BusEvent);
    }
  }

  /**
   * Source-tagged fan-out (Phase 6 / 决策 #88 / §4.8.2). The wrapper that
   * sits between a subagent / teammate Soul and this bus calls
   * `emitWithSource` so listeners (UI / wire bridge / telemetry) can
   * attribute every event back to its originating agent.
   *
   * Contract:
   *   - Returns `void` (铁律 4 — no back-pressure on Soul).
   *   - Does NOT mutate the caller's `event` argument; the envelope is
   *     attached on a shallow copy.
   *   - `source` is transport-only — never written to wire.jsonl
   *     (铁律 5; the sink wrapper persists the bare event through the
   *     child JournalWriter, see `createSubagentSinkWrapper`).
   *   - Listener errors are isolated by the same `safeDispatch` used by
   *     `emit`.
   */
  emitWithSource(event: SoulEvent, source: EventSource): void {
    const tagged = { ...event, source } as BusEvent;
    const snapshot = this.listeners.slice();
    for (const listener of snapshot) {
      safeDispatch(listener, tagged);
    }
  }

  /**
   * Fan out a notification to all notification subscribers (Slice 2.4).
   * Kept as a dedicated channel rather than folded into `SoulEvent` so
   * the Soul layer stays ignorant of SoulPlus-level concepts
   * (notification is an §5.2.4 SoulPlus concern, not a §5.2.1 Soul one).
   * Listener errors are swallowed with the same safeEmit discipline as
   * `emit` — a misbehaving wire subscriber cannot block other sinks.
   *
   * Phase 20 §C.3 (R-5) — optional `onError` callback lets callers
   * observe swallowed listener exceptions without breaking the bus-
   * accepted delivery semantic (`delivered_at.wire` still fires). The
   * callback runs in the bus frame; its own errors are ignored.
   */
  emitNotification(
    notif: NotificationData,
    onError?: (err: unknown) => void,
  ): void {
    const snapshot = this.notificationListeners.slice();
    for (const listener of snapshot) {
      safeDispatch(listener, notif, onError);
    }
  }

  on(listener: SessionEventListener): void {
    this.listeners.push(listener);
  }

  off(listener: SessionEventListener): void {
    const idx = this.listeners.indexOf(listener);
    if (idx !== -1) {
      this.listeners.splice(idx, 1);
    }
  }

  /** Subscribe to notification fan-out (Slice 2.4). */
  subscribeNotifications(listener: NotificationListener): void {
    this.notificationListeners.push(listener);
  }

  unsubscribeNotifications(listener: NotificationListener): void {
    const idx = this.notificationListeners.indexOf(listener);
    if (idx !== -1) {
      this.notificationListeners.splice(idx, 1);
    }
  }

  listenerCount(): number {
    return this.listeners.length;
  }

  notificationListenerCount(): number {
    return this.notificationListeners.length;
  }
}

/**
 * Shared sync+async safe-dispatch helper for both channels. Mirrors the
 * pattern in `src/soul/run-turn.ts::safeEmit`. A sync throw is caught
 * and swallowed; an async rejection is caught via a terminal `.catch`
 * so nothing reaches Node's unhandled-rejection handler.
 */
function safeDispatch<A>(
  fn: (arg: A) => void | Promise<void>,
  arg: A,
  onError?: (err: unknown) => void,
): void {
  const reportError = (error: unknown): void => {
    if (onError === undefined) return;
    try {
      onError(error);
    } catch {
      // A faulty onError callback must not crash the dispatcher.
    }
  };

  let maybePromise: void | Promise<void>;
  try {
    maybePromise = fn(arg);
  } catch (error) {
    reportError(error);
    return;
  }
  if (
    maybePromise !== undefined &&
    maybePromise !== null &&
    typeof (maybePromise as { then?: unknown }).then === 'function' &&
    typeof (maybePromise as { catch?: unknown }).catch === 'function'
  ) {
    maybePromise.catch((error: unknown) => {
      reportError(error);
    });
  }
}
