/**
 * Slice 20-B R-5 (part 2) — NotificationManager structured logger.
 *
 * NotificationManager currently accepts:
 *   logger?: ((msg: string, err: unknown) => void) | undefined
 * and falls back to `console.warn` when no logger is injected (src
 * notification-manager.ts:422). That means:
 *   1. Production runs emit naked `console.warn` — unstructured, no
 *      session/agent context.
 *   2. Callers that want structured logging have to wrap each site in
 *      a shim to translate `(msg, err)` into pino / winston etc.
 *
 * Phase 20 §C.3 upgrades the dep to the shared `Logger` interface from
 * `src/utils/logger.ts`. Recommendation (waiting on Coordinator sign-off):
 *   - **Break the old callback shape.** The old signature has no
 *     in-the-wild consumers outside this repo (kimi-core is private to
 *     the monorepo; all three call sites — notification-manager.test,
 *     notification-subagent-isolation.test, task-integration — supply
 *     `() => {}` stubs that trivially become `noopLogger`).
 *   - No dual-signature deprecation window; callers migrate in the same
 *     commit.
 *
 * Red bars below:
 *   - `deps.logger` is typed `Logger`, not the old `(msg, err)` callback.
 *   - When a sink throws, the injected `logger.warn` is invoked with a
 *     structured meta bag (the error + a useful scope key).
 *   - `console.warn` is NOT touched when a logger is present.
 *   - When no logger is provided, `noopLogger` swallows silently —
 *     bare-metal tests don't regress, and `console.warn` is still zero.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  NotificationManager,
  SessionEventBus,
} from '../../src/soul-plus/index.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import type { Logger } from '../../src/utils/logger.js';

function baseInput() {
  return {
    category: 'task' as const,
    type: 'task.succeeded',
    source_kind: 'background_task',
    source_id: 'bg_1',
    title: 'Build done',
    body: 'Build passed',
    severity: 'success' as const,
  };
}

interface LoggerCall {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly msg: string;
  readonly meta?: Record<string, unknown> | undefined;
}

/** Minimal stub Logger that records every call for assertions. */
function makeRecordingLogger(): { logger: Logger; calls: LoggerCall[] } {
  const calls: LoggerCall[] = [];
  const make = (bindings: Record<string, unknown> = {}): Logger => ({
    debug: (msg, meta) =>
      calls.push({ level: 'debug', msg, meta: { ...bindings, ...meta } }),
    info: (msg, meta) =>
      calls.push({ level: 'info', msg, meta: { ...bindings, ...meta } }),
    warn: (msg, meta) =>
      calls.push({ level: 'warn', msg, meta: { ...bindings, ...meta } }),
    error: (msg, meta) =>
      calls.push({ level: 'error', msg, meta: { ...bindings, ...meta } }),
    child: (b) => make({ ...bindings, ...b }),
  });
  return { logger: make(), calls };
}

let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- vitest MockInstance is any-typed; restoration is safe.
  warnSpy?.mockRestore();
  warnSpy = undefined;
});

describe('Phase 20 R-5 — NotificationManager uses Logger', () => {
  it('accepts deps.logger typed as Logger (break: old (msg, err) callback rejected at type level)', () => {
    const { logger } = makeRecordingLogger();
    // Compile-time: this construction typechecks iff
    // NotificationManagerDeps.logger is `Logger | undefined`.
    const mgr = new NotificationManager({
      sessionJournal: new InMemorySessionJournalImpl(),
      sessionEventBus: new SessionEventBus(),
      logger,
    });
    expect(mgr).toBeInstanceOf(NotificationManager);
  });

  it('routes swallowed-sink errors through logger.warn with structured meta', async () => {
    const { logger, calls } = makeRecordingLogger();
    const eventBus = new SessionEventBus();
    eventBus.subscribeNotifications(() => {
      throw new Error('wire subscriber boom');
    });

    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mgr = new NotificationManager({
      sessionJournal: new InMemorySessionJournalImpl(),
      sessionEventBus: eventBus,
      onEmittedToLlm: () => {
        // noop
      },
      logger,
    });

    await mgr.emit(baseInput());

    // A warn call was recorded with the error attached as structured
    // meta — not interpolated into the msg.
    const warnCall = calls.find((c) => c.level === 'warn');
    expect(warnCall).toBeDefined();
    expect(warnCall!.meta).toBeDefined();
    // The error should be attached to meta under some key
    // (implementer picks the key — `err` is conventional).
    const metaValues = Object.values(warnCall!.meta!);
    const hasErr = metaValues.some(
      (v) => v instanceof Error || (typeof v === 'string' && v.includes('wire subscriber boom')),
    );
    expect(hasErr).toBe(true);
  });

  it('does NOT invoke console.warn when a Logger is injected', async () => {
    const { logger } = makeRecordingLogger();
    const eventBus = new SessionEventBus();
    eventBus.subscribeNotifications(() => {
      throw new Error('boom');
    });

    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mgr = new NotificationManager({
      sessionJournal: new InMemorySessionJournalImpl(),
      sessionEventBus: eventBus,
      onEmittedToLlm: () => {
        // noop
      },
      logger,
    });

    await mgr.emit(baseInput());

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('when no logger is supplied, still does NOT invoke console.warn (default = noopLogger)', async () => {
    const eventBus = new SessionEventBus();
    eventBus.subscribeNotifications(() => {
      throw new Error('boom');
    });

    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mgr = new NotificationManager({
      sessionJournal: new InMemorySessionJournalImpl(),
      sessionEventBus: eventBus,
      onEmittedToLlm: () => {
        // noop
      },
      // logger intentionally absent
    });

    await expect(mgr.emit(baseInput())).resolves.toMatchObject({
      deduped: false,
    });

    // Key assertion — the grep sentinel for `console.warn` in src must
    // stay zero even when no logger is injected. This forces the
    // default-to-noopLogger fix instead of a fallback to console.warn.
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
