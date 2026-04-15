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

/**
 * Listener signature. `void | Promise<void>` (rather than bare `void`) so
 * callers can legitimately write `async` listeners — the bus will isolate
 * any rejected promise via a terminal `.catch` attached inside `emit`.
 */
export type SessionEventListener = (event: SoulEvent) => void | Promise<void>;

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
    // cannot shift the iteration it is part of.
    const snapshot = this.listeners.slice();
    for (const listener of snapshot) {
      safeDispatch(listener, event);
    }
  }

  /**
   * Fan out a notification to all notification subscribers (Slice 2.4).
   * Kept as a dedicated channel rather than folded into `SoulEvent` so
   * the Soul layer stays ignorant of SoulPlus-level concepts
   * (notification is an §5.2.4 SoulPlus concern, not a §5.2.1 Soul one).
   * Listener errors are swallowed with the same safeEmit discipline as
   * `emit` — a misbehaving wire subscriber cannot block other sinks.
   */
  emitNotification(notif: NotificationData): void {
    const snapshot = this.notificationListeners.slice();
    for (const listener of snapshot) {
      safeDispatch(listener, notif);
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
function safeDispatch<A>(fn: (arg: A) => void | Promise<void>, arg: A): void {
  let maybePromise: void | Promise<void>;
  try {
    maybePromise = fn(arg);
  } catch {
    return;
  }
  if (
    maybePromise !== undefined &&
    maybePromise !== null &&
    typeof (maybePromise as { then?: unknown }).then === 'function' &&
    typeof (maybePromise as { catch?: unknown }).catch === 'function'
  ) {
    maybePromise.catch(() => {
      // swallow async listener rejection
    });
  }
}
