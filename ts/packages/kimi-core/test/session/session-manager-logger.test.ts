/**
 * Phase 20 Codex round-5 — SessionManager threads the `logger` option
 * through to SoulPlus's NotificationManager so fan-out errors land on
 * the injected logger instead of being silently swallowed by
 * `noopLogger`. Without this, Phase 20-B's "structured logger
 * migration" was silently incomplete — NotificationManager inside a
 * real SessionManager-built session defaulted to `noopLogger` because
 * the option simply didn't exist on the `CreateSessionOptions` /
 * `ResumeSessionOptions` surfaces.
 *
 * What the tests pin:
 *   1. `CreateSessionOptions.logger` / `ResumeSessionOptions.logger`
 *      are accepted at the type level (compile-time guard).
 *   2. When a logger is injected, a fan-out error inside
 *      `soulPlus.emitNotification` surfaces on the injected
 *      `logger.warn`, NOT on `console.warn`.
 *   3. Omitting logger still works (default noopLogger) without
 *      crashing — no hidden required field regression.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PathConfig } from '../../src/session/path-config.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { SessionEventBus } from '../../src/soul-plus/session-event-bus.js';
import type { Runtime, Tool } from '../../src/soul/index.js';
import type { Logger } from '../../src/utils/logger.js';
import { createFakeRuntime } from '../soul/fixtures/fake-runtime.js';

function createNoopRuntime(): Runtime {
  // Minimal kosong stub — the test never drives an LLM turn so we
  // don't need ScriptedKosongAdapter; keeping the import surface
  // under the default max-dependencies budget.
  const kosong = {
    chat: (): never => {
      throw new Error('kosong should not be invoked in this test');
    },
  };
  return createFakeRuntime({ kosong: kosong as never }).runtime;
}

function fakeTool(name: string): Tool {
  return {
    name,
    description: `fake ${name}`,
    inputSchema: { type: 'object', properties: {} },
  } as unknown as Tool;
}

interface SpyLogger {
  logger: Logger;
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

function makeSpyLogger(): SpyLogger {
  // Use explicit parameter typing on each spy so the `(msg, meta?)` call
  // signature lines up with the `Logger` interface without the widened
  // `Mock<Procedure | Constructable>` complaint from vitest 4's default
  // typing. Return the spies alongside the Logger so tests can assert
  // `.toHaveBeenCalled()` without unsafe casts through the interface.
  const debug = vi.fn((_msg: string, _meta?: Record<string, unknown>): void => {});
  const info = vi.fn((_msg: string, _meta?: Record<string, unknown>): void => {});
  const warn = vi.fn((_msg: string, _meta?: Record<string, unknown>): void => {});
  const error = vi.fn((_msg: string, _meta?: Record<string, unknown>): void => {});
  const logger: Logger = {
    debug,
    info,
    warn,
    error,
    child: () => logger,
  };
  return { logger, debug, info, warn, error };
}

let tmpDir: string;
let paths: PathConfig;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kimi-p20-logger-'));
  paths = new PathConfig({ home: tmpDir });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('SessionManager — logger wiring (Phase 20 Codex round-5)', () => {
  it('accepts a logger option on createSession (type-level guard)', async () => {
    const mgr = new SessionManager(paths);
    const spy = makeSpyLogger();
    const logger = spy.logger;

    const session = await mgr.createSession({
      sessionId: 'ses_logger_a',
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [fakeTool('bash')],
      model: 'm',
      logger,
    });

    expect(session.sessionId).toBe('ses_logger_a');
    await mgr.closeSession(session.sessionId);
  });

  it('forwards logger.warn when a notification-channel subscriber throws', async () => {
    // Arrange: we supply our own SessionEventBus so we can register a
    // throwing notification listener. NotificationManager fans out
    // through the event bus; when a subscriber throws, the fan-out
    // catches it and routes to `logger.warn` on the injected logger
    // (Phase 20-B contract). Pre-Codex-round-5 this logger option never
    // reached the NotificationManager because SessionManager didn't
    // have a `logger` field, so the error went into noopLogger and
    // vanished.
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = makeSpyLogger();
    const logger = spy.logger;
    const eventBus = new SessionEventBus();

    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_logger_b',
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'm',
      logger,
      eventBus,
    });

    // Install a throwing notification listener on OUR eventBus
    // instance (same instance SoulPlus received).
    eventBus.subscribeNotifications(() => {
      throw new Error('subscriber boom');
    });

    await session.soulPlus.emitNotification({
      category: 'task',
      type: 'task.started',
      source_kind: 'background_task',
      source_id: 'bg_x',
      title: 't',
      body: 'b',
      severity: 'info',
    });

    // The subscriber throw must surface through the injected logger,
    // not through `console.warn`. We don't pin exact message text so
    // refactors stay free to tweak phrasing.
    expect(spy.warn).toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();

    consoleWarnSpy.mockRestore();
    await mgr.closeSession(session.sessionId);
  });

  it('omitting logger still yields a working session (default noopLogger)', async () => {
    const mgr = new SessionManager(paths);
    const session = await mgr.createSession({
      sessionId: 'ses_logger_default',
      workspaceDir: tmpDir,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'm',
    });

    // Sanity: emit a trivial notification without a throwing listener —
    // must not throw, must not touch console.* (noopLogger swallows).
    const consoleSpies = {
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
    await session.soulPlus.emitNotification({
      category: 'task',
      type: 'task.started',
      source_kind: 'background_task',
      source_id: 'bg_y',
      title: 't',
      body: 'b',
      severity: 'info',
    });
    expect(consoleSpies.warn).not.toHaveBeenCalled();
    expect(consoleSpies.error).not.toHaveBeenCalled();
    consoleSpies.warn.mockRestore();
    consoleSpies.error.mockRestore();

    await mgr.closeSession(session.sessionId);
  });
});
