/**
 * NotificationManager — SoulPlus-layer notification fan-out (v2 §5.2.4).
 *
 * Slice 2.4 responsibilities:
 *   - `emit(notif)` is the single push-mode entry point. It WAL-appends a
 *     `NotificationRecord` first, then fans out to the three targets
 *     (llm / wire / shell) with per-sink exception isolation.
 *   - LLM target: push into a caller-supplied callback (owned by
 *     `TurnManager.pendingNotifications`) so the next `buildMessages()`
 *     call can drain it as an `EphemeralInjection`. buildMessages stays
 *     synchronous and free of journal I/O.
 *   - Wire target: emit through `SessionEventBus.emitNotification` so UI
 *     / transport subscribers receive the notification in real time.
 *   - Shell target: optional callback (TUI toast / desktop notification).
 *     kimi-core does NOT implement the render surface — consumers (SDK /
 *     TUI) inject a `onShellDeliver` callback; absence means "skipped"
 *     (recorded as `delivered_at.shell = 0`).
 *   - `dedupe_key` de-duplication: if a previously emitted notification
 *     shared the same `dedupe_key`, the new call is a no-op and returns
 *     the already-persisted id (Python
 *     `notifications/manager.py:35-48` port).
 *
 * Non-goals in Slice 2.4:
 *   - Per-sink delivery state machine with retry (Python pull model).
 *     v2 is push-only; failed deliveries are logged and forgotten.
 *   - Plan-mode reminder / any history-derived injection. These are
 *     `DynamicInjectionProvider` territory (future slice).
 *   - Server-side shell hook execution (running user scripts). Out of
 *     Phase 2 scope (no plugin system).
 */

import { randomUUID } from 'node:crypto';

import type { HookEngine } from '../hooks/engine.js';
import type { NotificationInput } from '../hooks/types.js';
import type { EphemeralInjection } from '../storage/projector.js';
import type { SessionJournal } from '../storage/session-journal.js';
import type { NotificationRecord } from '../storage/wire-record.js';
import type { SessionEventBus } from './session-event-bus.js';

/**
 * NotificationData = the in-memory payload callers pass to `emit`. It
 * matches the on-wire `NotificationRecord.data` shape 1:1 so the
 * NotificationManager does no field translation. We derive it directly
 * from the record type to guarantee drift protection — renaming a field
 * in `wire-record.ts` immediately breaks callers that hand-code the
 * shape.
 */
export type NotificationData = NotificationRecord['data'];

/**
 * Shell-sink callback. kimi-core provides no default; absent means the
 * shell target is a no-op. The callback is invoked synchronously inside
 * `emit()` (wrapped in try/catch); the caller's implementation MUST NOT
 * throw or block.
 */
export type ShellDeliverCallback = (notif: NotificationData) => void;

/**
 * LLM-sink callback. Invoked synchronously after journal append; the
 * canonical wiring pushes the notification into
 * `TurnManager.pendingNotifications` so the next `buildMessages()` sees
 * it as an `EphemeralInjection`.
 */
export type LlmDeliverCallback = (notif: NotificationData) => void;

export interface NotificationManagerDeps {
  readonly sessionJournal: SessionJournal;
  readonly sessionEventBus: SessionEventBus;
  /**
   * Synchronous callback into the TurnManager's pendingNotifications
   * queue. Kept as a callback (not a TurnManager reference) so
   * NotificationManager has no cyclic dependency on TurnManager and so
   * tests can observe the LLM sink directly.
   */
  readonly onEmittedToLlm: LlmDeliverCallback;
  readonly onShellDeliver?: ShellDeliverCallback | undefined;
  /**
   * Optional logger for swallowed fan-out errors. Defaults to
   * `console.warn`. Tests inject a spy.
   */
  readonly logger?: ((msg: string, err: unknown) => void) | undefined;
  /**
   * Slice 3.6 — optional hook engine reference. When set, each `emit`
   * call fires the `Notification` hook event after the fan-out
   * completes. Fire-and-forget: hook subscribers cannot block or
   * modify the notification. Errors are swallowed through the same
   * `logger` path as other per-sink failures.
   */
  readonly hookEngine?: HookEngine | undefined;
  /**
   * Slice 3.6 — session id forwarded to hook input payloads. Defaults
   * to `'unknown'` when absent.
   */
  readonly sessionId?: string | undefined;
  /**
   * Slice 3.6 — callback that returns the currently active turn id at
   * the moment `emit` runs. NotificationManager cannot depend on
   * TurnManager directly (cyclic), so the host wires this callback in
   * to keep hook input payloads accurate. Defaults to returning
   * `'unknown'` when the session has no active turn.
   */
  readonly currentTurnId?: (() => string) | undefined;
  /**
   * Slice 3.6 — canonical agent id forwarded to hook input payloads.
   * Defaults to `'agent_main'`.
   */
  readonly agentId?: string | undefined;
}

/**
 * Shape accepted by `emit` — any field missing from `NotificationData`
 * that the manager can fill in itself (`id`, defaults) is optional here.
 * This keeps callers concise while still producing a fully-populated
 * `NotificationRecord` on disk.
 */
export interface EmitInput {
  id?: string | undefined;
  category: NotificationData['category'];
  type: string;
  source_kind: string;
  source_id: string;
  title: string;
  body: string;
  severity: NotificationData['severity'];
  payload?: Record<string, unknown> | undefined;
  targets?: NotificationData['targets'] | undefined;
  dedupe_key?: string | undefined;
}

export interface EmitResult {
  readonly id: string;
  readonly deduped: boolean;
  readonly delivered_at: {
    llm?: number | undefined;
    wire?: number | undefined;
    shell?: number | undefined;
  };
}

/**
 * Minimum length of a generated notification id. Mirrors Python
 * `n + 8 hex` ≈ 9 chars; we use `n_` + 10 hex for readability.
 */
function generateNotificationId(): string {
  // 10 hex chars of entropy — enough to be collision-free across any
  // realistic session, short enough to keep the XML tag concise.
  const hex = randomUUID().replaceAll('-', '').slice(0, 10);
  return `n_${hex}`;
}

export class NotificationManager {
  private readonly dedupeIndex = new Map<string, string>();
  /**
   * In-flight dedupe promises. While a `doEmit` for a given `dedupe_key`
   * is awaiting its journal append, concurrent `emit` calls with the same
   * key coalesce onto the same promise instead of each proceeding
   * independently (M1 race fix).
   */
  private readonly inFlightDedupe = new Map<string, Promise<string>>();

  /**
   * Slice 6.1 — count of notifications emitted to the LLM sink that have
   * not yet been drained by `markLlmDrained()`. This enables the host
   * loop to poll `hasPendingForLlm()` without scanning the journal.
   */
  private pendingLlmCount = 0;

  constructor(private readonly deps: NotificationManagerDeps) {}

  /**
   * Slice 6.1 — returns `true` when at least one notification has been
   * emitted to the LLM sink but not yet consumed by `markLlmDrained()`.
   */
  hasPendingForLlm(): boolean {
    return this.pendingLlmCount > 0;
  }

  /**
   * Slice 6.1 — mark all pending LLM notifications as consumed. Called
   * by the turn loop after injecting pending notifications into context.
   */
  markLlmDrained(): void {
    this.pendingLlmCount = 0;
  }

  /**
   * Emit a notification. WAL-then-mirror order (§4.5.6):
   *   1. dedupe_key check — return existing id if matched.
   *   1b. in-flight check — if another emit with the same dedupe_key is
   *       still awaiting journal append, coalesce onto its promise (M1).
   *   2. `await sessionJournal.appendNotification(record)`.
   *   3. fan out to llm / wire / shell with per-sink try/catch.
   *   4. return the id + per-sink delivered_at map.
   *
   * Fan-out exceptions are swallowed and logged. A failed llm or shell
   * sink marks its `delivered_at` entry as `undefined`; a skipped shell
   * sink (no callback) marks `delivered_at.shell = 0`.
   *
   * N.B. `delivered_at.wire` represents "bus accepted the dispatch" —
   * per-listener errors (sync throw / async reject) are swallowed inside
   * `SessionEventBus.safeDispatch` and are not observable here.
   * NotificationManager records a wire timestamp whenever
   * `emitNotification` returns without throwing. This is intentional:
   * wire delivery is fire-and-forget at the bus level (§4.6.3).
   *
   * The WAL record itself is written with an empty `delivered_at` map —
   * delivery state is NOT persisted in v2 (per §5 decision: single
   * append, no second write). Slice 2.4 treats delivery state as
   * derived, not durable.
   */
  async emit(input: EmitInput): Promise<EmitResult> {
    // ── 1. Dedupe check ────────────────────────────────────────────
    if (input.dedupe_key !== undefined) {
      const existing = this.dedupeIndex.get(input.dedupe_key);
      if (existing !== undefined) {
        return { id: existing, deduped: true, delivered_at: {} };
      }
      // ── 1b. In-flight check (M1 race fix) ─────────────────────
      // Another concurrent emit with the same dedupe_key is still
      // awaiting its journal append. Coalesce onto the same promise
      // so only one WAL record + one fan-out fires.
      const inFlight = this.inFlightDedupe.get(input.dedupe_key);
      if (inFlight !== undefined) {
        const id = await inFlight;
        return { id, deduped: true, delivered_at: {} };
      }
      // First writer: register in-flight before any await so
      // concurrent callers coalesce rather than both proceeding.
      const resultPromise = this.doEmit(input);
      const idPromise = resultPromise.then((r) => r.id);
      // Prevent unhandled rejection when no concurrent caller awaits
      idPromise.catch(() => {});
      this.inFlightDedupe.set(input.dedupe_key, idPromise);
      try {
        const result = await resultPromise;
        this.dedupeIndex.set(input.dedupe_key, result.id);
        return result;
      } finally {
        this.inFlightDedupe.delete(input.dedupe_key);
      }
    }
    // No dedupe_key → direct emit, no coalescing needed
    return this.doEmit(input);
  }

  /**
   * Core emit path: generate id, WAL-append, fan-out to sinks.
   * Extracted from `emit()` so the dedupe + in-flight coordination
   * lives in the caller and this method stays straightforward.
   */
  private async doEmit(input: EmitInput): Promise<EmitResult> {
    const id = input.id ?? generateNotificationId();
    const targets = input.targets ?? ['llm', 'wire', 'shell'];

    const data: NotificationData = {
      id,
      category: input.category,
      type: input.type,
      source_kind: input.source_kind,
      source_id: input.source_id,
      title: input.title,
      body: input.body,
      severity: input.severity,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      targets,
      ...(input.dedupe_key !== undefined ? { dedupe_key: input.dedupe_key } : {}),
      // `delivered_at` is deliberately omitted — delivery state is
      // derived at emit time, not durable. Absence means "unknown" to
      // any reader of the journal.
    };

    // ── 2. WAL append (blocking) ──────────────────────────────────
    await this.deps.sessionJournal.appendNotification({
      type: 'notification',
      data,
    });

    // ── 3. Three-way fan-out with per-sink isolation ──────────────
    const deliveredAt: {
      llm?: number | undefined;
      wire?: number | undefined;
      shell?: number | undefined;
    } = {};
    const wantsLlm = targets.includes('llm');
    const wantsWire = targets.includes('wire');
    const wantsShell = targets.includes('shell');

    if (wantsLlm) {
      try {
        this.deps.onEmittedToLlm(data);
        deliveredAt.llm = Date.now();
        // Slice 6.1 — track pending LLM notifications
        this.pendingLlmCount += 1;
      } catch (error) {
        this.logWarn('notification llm sink failed', error);
      }
    }

    if (wantsWire) {
      try {
        // delivered_at.wire = "bus accepted the dispatch". Per-listener
        // errors are swallowed by SessionEventBus.safeDispatch; see the
        // emit() JSDoc N.B. for the full semantics.
        this.deps.sessionEventBus.emitNotification(data);
        deliveredAt.wire = Date.now();
      } catch (error) {
        this.logWarn('notification wire sink failed', error);
      }
    }

    if (wantsShell) {
      if (this.deps.onShellDeliver !== undefined) {
        try {
          this.deps.onShellDeliver(data);
          deliveredAt.shell = Date.now();
        } catch (error) {
          this.logWarn('notification shell sink failed', error);
        }
      } else {
        // Sentinel "0" means "intentionally skipped — no shell
        // subscriber registered". Callers that care about the
        // distinction between failed and skipped can check for 0.
        deliveredAt.shell = 0;
      }
    }

    // Slice 3.6 — Notification lifecycle hook. Dispatched after the
    // three-way sink fan-out completes so a hook subscriber reading
    // the journal sees the exact same NotificationData. Fire-and-
    // forget: hook errors are swallowed via `logWarn` and do NOT
    // affect the returned `EmitResult`.
    this.dispatchNotificationHook(data);

    return { id, deduped: false, delivered_at: deliveredAt };
  }

  private dispatchNotificationHook(data: NotificationData): void {
    const engine = this.deps.hookEngine;
    if (engine === undefined) return;
    const input: NotificationInput = {
      event: 'Notification',
      sessionId: this.deps.sessionId ?? 'unknown',
      turnId: this.deps.currentTurnId?.() ?? 'unknown',
      agentId: this.deps.agentId ?? 'agent_main',
      notificationType: data.type,
      title: data.title,
      body: data.body,
      severity: data.severity,
    };
    const controller = new AbortController();
    engine.executeHooks('Notification', input, controller.signal).catch((error: unknown) => {
      this.logWarn('notification hook dispatch failed', error);
    });
  }

  /**
   * Prime the dedupe index from replayed notification records
   * (crash-recovery). Phase 2 Slice 2.4 ships this as a stub hook —
   * Slice 5+ replay path will iterate `wire.jsonl` and invoke it for
   * each persisted notification with a `dedupe_key`.
   */
  primeDedupeIndex(records: readonly NotificationRecord[]): void {
    for (const r of records) {
      if (r.data.dedupe_key !== undefined) {
        this.dedupeIndex.set(r.data.dedupe_key, r.data.id);
      }
    }
  }

  /**
   * Slice 5.2 (T3.1+T3.6) — push-only resume re-inject for llm
   * notifications.
   *
   * For each persisted notification record whose targets include `llm`
   * AND whose id never appeared in any persisted message body as
   * `<notification id="${id}"`, push it as an EphemeralInjection so the
   * next buildMessages() includes it. This recovers notifications that
   * were emitted before the previous CLI process exited but never
   * reached an actual LLM turn.
   *
   * Idempotent: caller must scan delivered ids from the *projected*
   * messages (i.e. `projectReplayState(records).messages`) to know
   * which notifications already landed in transcript.
   *
   * Returns the injections it stashed (mostly for telemetry / tests).
   */
  replayPendingForResume(
    notificationRecords: readonly NotificationRecord[],
    contextState: { stashEphemeralInjection(injection: EphemeralInjection): void },
    deliveredIds: ReadonlySet<string>,
  ): EphemeralInjection[] {
    const injected: EphemeralInjection[] = [];
    for (const r of notificationRecords) {
      const targets = r.data.targets ?? ['llm', 'wire', 'shell'];
      if (!targets.includes('llm')) continue;
      if (deliveredIds.has(r.data.id)) continue;
      const injection: EphemeralInjection = {
        kind: 'pending_notification',
        content: r.data,
      };
      contextState.stashEphemeralInjection(injection);
      injected.push(injection);
    }
    // Slice 6.1: replayed notifications count as pending for LLM
    this.pendingLlmCount += injected.length;
    return injected;
  }

  /**
   * Slice 5.2 helper — scan replayed conversation messages for any
   * `<notification id="${id}">` markers so callers can build the
   * delivered-id set for `replayPendingForResume`. Lives here (vs.
   * projector.ts) to keep the notification XML format encoding/decoding
   * in one place.
   */
  static extractDeliveredIds(
    messages: readonly { role?: string; content: unknown }[],
  ): Set<string> {
    const ids = new Set<string>();
    const re = /<notification[^>]*\bid="([^"]+)"/g;
    for (const m of messages) {
      // Codex M1: only scan user-role messages (notifications are injected as
      // synthetic user messages). Scanning assistant/tool output would pick up
      // false positives where the LLM echoes or quotes notification XML.
      if (m.role !== undefined && m.role !== 'user') continue;
      const c = m.content;
      if (typeof c === 'string') {
        for (const match of c.matchAll(re)) ids.add(match[1]!);
        continue;
      }
      if (Array.isArray(c)) {
        for (const part of c) {
          if (
            typeof part === 'object' &&
            part !== null &&
            'text' in part &&
            typeof (part as { text?: unknown }).text === 'string'
          ) {
            for (const match of (part as { text: string }).text.matchAll(re)) {
              ids.add(match[1]!);
            }
          }
        }
      }
    }
    return ids;
  }

  private logWarn(msg: string, err: unknown): void {
    if (this.deps.logger !== undefined) {
      this.deps.logger(msg, err);
      return;
    }
    // eslint-disable-next-line no-console
    console.warn(msg, err);
  }
}
