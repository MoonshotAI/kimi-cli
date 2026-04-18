/**
 * Slice 20-B R-5 — `Logger` interface contract (Phase 20 §C.3).
 *
 * kimi-core must stay transport-agnostic — pino is only loaded on the
 * apps/kimi-cli side. The core ships a tiny `Logger` interface that
 * callers (NotificationManager / MCPManager / …) depend on, plus two
 * default implementations:
 *
 *   - `noopLogger` — used when callers don't inject a real logger;
 *     default for every `logger?: Logger` dep so tests don't have to
 *     wire anything (铁律: default = no output, no crash).
 *   - `consoleLogger` — dev-loop convenience; forwards to
 *     `console.{debug,info,warn,error}` and carries `child` bindings
 *     by merging them into the `meta` bag.
 *
 * These assertions drive:
 *   - shape compatibility with pino (5 methods + `child`),
 *   - correct no-op behaviour,
 *   - correct console forwarding with meta merging,
 *   - recursive `child(...).child(...)` binding inheritance.
 *
 * The file is red today because `src/utils/logger.ts` doesn't exist.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { consoleLogger, noopLogger, type Logger } from '../../src/utils/logger.js';

// ── Shape — the 5-method + child interface ──────────────────────────────

describe('Phase 20 R-5 — Logger interface shape', () => {
  it('noopLogger implements the full contract', () => {
    // Compile-time: noopLogger must satisfy Logger.
    const l: Logger = noopLogger;
    expect(typeof l.debug).toBe('function');
    expect(typeof l.info).toBe('function');
    expect(typeof l.warn).toBe('function');
    expect(typeof l.error).toBe('function');
    expect(typeof l.child).toBe('function');
  });

  it('consoleLogger implements the full contract', () => {
    const l: Logger = consoleLogger;
    expect(typeof l.debug).toBe('function');
    expect(typeof l.info).toBe('function');
    expect(typeof l.warn).toBe('function');
    expect(typeof l.error).toBe('function');
    expect(typeof l.child).toBe('function');
  });
});

// ── noopLogger semantics ────────────────────────────────────────────────

describe('Phase 20 R-5 — noopLogger', () => {
  it('never calls console.* on any level', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    noopLogger.debug('d', { a: 1 });
    noopLogger.info('i');
    noopLogger.warn('w', { b: 2 });
    noopLogger.error('e', { c: 3 });

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    debugSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('child() returns something that also emits nothing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const scoped = noopLogger.child({ session_id: 's1' });
    scoped.warn('still silent', { more: true });
    const deeper = scoped.child({ turn_id: 't1' });
    deeper.warn('also silent');

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('child() return value satisfies the Logger interface', () => {
    const scoped: Logger = noopLogger.child({ a: 1 });
    expect(typeof scoped.warn).toBe('function');
    expect(typeof scoped.child).toBe('function');
  });
});

// ── consoleLogger semantics ─────────────────────────────────────────────

describe('Phase 20 R-5 — consoleLogger forwarding', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    /* eslint-disable @typescript-eslint/no-unsafe-call
       -- `vi.spyOn(...)` returns `MockInstance<any>`; `.mockRestore()`
       is trivially safe here and the alternative (typing the locals as
       a specific MockInstance generic) leaks vitest internals. */
    debugSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    /* eslint-enable @typescript-eslint/no-unsafe-call */
  });

  it('warn(msg, meta) forwards to console.warn exactly once', () => {
    consoleLogger.warn('boom', { session_id: 's1' });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const call = warnSpy.mock.calls[0]!;
    // First arg is the msg; second arg carries meta as object.
    expect(call[0]).toBe('boom');
    expect(call[1]).toMatchObject({ session_id: 's1' });
  });

  it('each level routes to its matching console method', () => {
    consoleLogger.debug('d');
    consoleLogger.info('i');
    consoleLogger.warn('w');
    consoleLogger.error('e');

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('child(bindings) merges bindings into subsequent meta', () => {
    const scoped = consoleLogger.child({ session_id: 's1', agent_id: 'main' });
    scoped.warn('close failed', { server: 'files' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const call = warnSpy.mock.calls[0]!;
    expect(call[0]).toBe('close failed');
    expect(call[1]).toMatchObject({
      session_id: 's1',
      agent_id: 'main',
      server: 'files',
    });
  });

  it('child().child() inherits all bindings from every ancestor', () => {
    const a = consoleLogger.child({ session_id: 's1' });
    const b = a.child({ turn_id: 't7' });
    b.warn('inherits', { step: 3 });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const call = warnSpy.mock.calls[0]!;
    expect(call[1]).toMatchObject({
      session_id: 's1',
      turn_id: 't7',
      step: 3,
    });
  });

  it('call-site meta wins on key conflict (most specific scope)', () => {
    const scoped = consoleLogger.child({ who: 'parent' });
    scoped.warn('override', { who: 'callsite' });
    const call = warnSpy.mock.calls[0]!;
    // Call-site `who` overrides the bound `who` — standard pino
    // semantics so adapters drop in interchangeably.
    expect(call[1]).toMatchObject({ who: 'callsite' });
  });
});
