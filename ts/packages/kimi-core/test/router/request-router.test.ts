/**
 * RequestRouter — five-channel dispatch tests (§6.1).
 *
 * Rewritten from Python E2E tests (test_wire_protocol.py, test_wire_prompt.py,
 * test_wire_steer.py, test_wire_config.py) to v2 in-process unit tests.
 * Python tests spawned a subprocess and communicated via stdin/stdout;
 * v2 tests use MemoryTransport and direct RequestRouter calls.
 *
 * All tests FAIL (red bar) until Slice 5 Phase 3 implementation.
 */

import { describe, expect, it, vi } from 'vitest';

import { RequestRouter } from '../../src/router/index.js';
import type { Transport } from '../../src/transport/types.js';
import type { WireMessage } from '../../src/wire-protocol/types.js';

// ── Fake transport for testing ───────────────────────────────────────────

function createFakeTransport(): Transport {
  return {
    state: 'connected' as const,
    connect: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onMessage: null,
    onConnect: null,
    onClose: null,
    onError: null,
  };
}

// ── Fake SessionManager ─────────────────────────────────────────────────

function createFakeSessionManager() {
  const sessions = new Map<string, { sessionId: string }>();
  return {
    sessions,
    get(sessionId: string) {
      return sessions.get(sessionId);
    },
  };
}

// ── Helper: build a minimal WireMessage ─────────────────────────────────

function buildRequest(overrides: Partial<WireMessage>): WireMessage {
  return {
    id: 'req_test',
    time: Date.now(),
    session_id: '__process__',
    type: 'request',
    from: 'client',
    to: 'core',
    method: 'initialize',
    ...overrides,
  };
}

// ── Method registration ─────────────────────────────────────────────────

describe('RequestRouter method registration', () => {
  it('registers a process-level method handler', () => {
    const sm = createFakeSessionManager();
    const router = new RequestRouter({ sessionManager: sm });
    const handler = vi.fn(async () => {
      // handler stub
    });

    router.registerProcessMethod('initialize', handler);

    // No throw — registration accepted
    expect(handler).not.toHaveBeenCalled();
  });

  it('registers a session-level method with channel type', () => {
    const sm = createFakeSessionManager();
    const router = new RequestRouter({ sessionManager: sm });
    const handler = vi.fn(async () => {
      // handler stub
    });

    router.registerMethod('session.prompt', 'conversation', handler);

    expect(handler).not.toHaveBeenCalled();
  });
});

// ── Process-level dispatch ──────────────────────────────────────────────

describe('RequestRouter process dispatch', () => {
  it('routes initialize to process handler', async () => {
    const sm = createFakeSessionManager();
    const router = new RequestRouter({ sessionManager: sm });
    const transport = createFakeTransport();
    const handler = vi.fn(async () =>
      buildRequest({ type: 'response', request_id: 'req_init' } as Partial<WireMessage>),
    );

    router.registerProcessMethod('initialize', handler);

    const msg = buildRequest({ id: 'req_init', method: 'initialize' });
    await router.dispatch(msg, transport);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('routes session.create to process handler', async () => {
    const sm = createFakeSessionManager();
    const router = new RequestRouter({ sessionManager: sm });
    const transport = createFakeTransport();
    const handler = vi.fn(async () => {
      // handler stub
    });

    router.registerProcessMethod('session.create', handler);

    const msg = buildRequest({
      id: 'req_create',
      method: 'session.create',
      session_id: '__process__',
    });
    await router.dispatch(msg, transport);

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ── Session-level dispatch (rewrite of test_wire_prompt.py) ─────────────

describe('RequestRouter session dispatch', () => {
  it('routes session.prompt to conversation handler', async () => {
    const sm = createFakeSessionManager();
    sm.sessions.set('ses_abc', { sessionId: 'ses_abc' });
    const router = new RequestRouter({ sessionManager: sm });
    const transport = createFakeTransport();
    const handler = vi.fn(async () => {
      // handler stub
    });

    router.registerMethod('session.prompt', 'conversation', handler);

    const msg = buildRequest({
      id: 'req_prompt',
      session_id: 'ses_abc',
      method: 'session.prompt',
      data: { input: 'hello' },
    });
    await router.dispatch(msg, transport);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('returns error for unknown session', async () => {
    const sm = createFakeSessionManager();
    const router = new RequestRouter({ sessionManager: sm });
    const transport = createFakeTransport();

    const msg = buildRequest({
      id: 'req_prompt',
      session_id: 'ses_nonexistent',
      method: 'session.prompt',
    });

    await expect(router.dispatch(msg, transport)).rejects.toThrow(/not found/i);
  });

  it('returns error for unknown method', async () => {
    const sm = createFakeSessionManager();
    sm.sessions.set('ses_abc', { sessionId: 'ses_abc' });
    const router = new RequestRouter({ sessionManager: sm });
    const transport = createFakeTransport();

    const msg = buildRequest({
      id: 'req_unknown',
      session_id: 'ses_abc',
      method: 'session.nonexistent',
    });

    await expect(router.dispatch(msg, transport)).rejects.toThrow(/not found/i);
  });
});

// ── Response routing (pending request resolution) ───────────────────────

describe('RequestRouter response routing', () => {
  it('resolves pending request when response arrives', async () => {
    const sm = createFakeSessionManager();
    const router = new RequestRouter({ sessionManager: sm });
    const transport = createFakeTransport();
    const resolver = vi.fn();

    router.registerPendingRequest('req_approval', resolver);

    const responseMsg = buildRequest({
      id: 'res_001',
      type: 'response',
      request_id: 'req_approval',
      session_id: 'ses_abc',
    } as Partial<WireMessage>);

    await router.dispatch(responseMsg, transport);

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(responseMsg);
  });
});

// ── Phase 21 §A — pending-request cancellation (MAJOR-2) ────────────────

describe('RequestRouter pending-request cancellation', () => {
  it('cancelPendingRequest rejects the caller and removes the map entry', async () => {
    const sm = createFakeSessionManager();
    const router = new RequestRouter({ sessionManager: sm });
    const transport = createFakeTransport();
    const resolve = vi.fn();
    const reject = vi.fn();

    router.registerPendingRequest('req_timeout', resolve, reject);
    const cancelled = router.cancelPendingRequest('req_timeout', new Error('boom'));
    expect(cancelled).toBe(true);
    expect(reject).toHaveBeenCalledTimes(1);
    expect((reject.mock.calls[0]?.[0] as Error).message).toBe('boom');

    // Map entry gone → a late-arriving response is a no-op, resolve never
    // fires. Before the fix the entry would still be in the map (only the
    // local cleanup ran), so the late response would wake the already-
    // rejected promise with a second settle attempt.
    const late = buildRequest({
      id: 'res_late',
      type: 'response',
      request_id: 'req_timeout',
      session_id: 'ses_abc',
    } as Partial<WireMessage>);
    await router.dispatch(late, transport);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('cancelPendingRequest returns false when the id is unknown or already settled', () => {
    const sm = createFakeSessionManager();
    const router = new RequestRouter({ sessionManager: sm });
    expect(router.cancelPendingRequest('req_nope')).toBe(false);

    const resolve = vi.fn();
    const reject = vi.fn();
    router.registerPendingRequest('req_once', resolve, reject);
    expect(router.cancelPendingRequest('req_once')).toBe(true);
    // Second call against the same id is a no-op — prevents double-reject.
    expect(router.cancelPendingRequest('req_once')).toBe(false);
    expect(reject).toHaveBeenCalledTimes(1);
  });

  it('rejectAllPending rejects every in-flight request (Phase 21 §A regression)', () => {
    const sm = createFakeSessionManager();
    const router = new RequestRouter({ sessionManager: sm });
    const rejectA = vi.fn();
    const rejectB = vi.fn();

    router.registerPendingRequest('req_a', vi.fn(), rejectA);
    router.registerPendingRequest('req_b', vi.fn(), rejectB);

    router.rejectAllPending('transport closed');

    expect(rejectA).toHaveBeenCalledTimes(1);
    expect(rejectB).toHaveBeenCalledTimes(1);
    expect((rejectA.mock.calls[0]?.[0] as Error).message).toBe('transport closed');
    // Calling cancelPendingRequest on a cleared id must return false.
    expect(router.cancelPendingRequest('req_a')).toBe(false);
    expect(router.cancelPendingRequest('req_b')).toBe(false);
  });
});

// ── Five-channel routing (rewrite of conceptual routing from Python) ────

describe('RequestRouter five-channel routing', () => {
  it('routes config method to config channel', async () => {
    const sm = createFakeSessionManager();
    sm.sessions.set('ses_abc', { sessionId: 'ses_abc' });
    const router = new RequestRouter({ sessionManager: sm });
    const transport = createFakeTransport();
    const handler = vi.fn(async () => {
      // handler stub
    });

    router.registerMethod('session.setModel', 'config', handler);

    const msg = buildRequest({
      id: 'req_model',
      session_id: 'ses_abc',
      method: 'session.setModel',
      data: { model: 'gpt-4' },
    });
    await router.dispatch(msg, transport);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('routes management method to management channel', async () => {
    const sm = createFakeSessionManager();
    sm.sessions.set('ses_abc', { sessionId: 'ses_abc' });
    const router = new RequestRouter({ sessionManager: sm });
    const transport = createFakeTransport();
    const handler = vi.fn(async () => {
      // handler stub
    });

    router.registerMethod('session.getStatus', 'management', handler);

    const msg = buildRequest({
      id: 'req_status',
      session_id: 'ses_abc',
      method: 'session.getStatus',
    });
    await router.dispatch(msg, transport);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('routes tools method to tools channel', async () => {
    const sm = createFakeSessionManager();
    sm.sessions.set('ses_abc', { sessionId: 'ses_abc' });
    const router = new RequestRouter({ sessionManager: sm });
    const transport = createFakeTransport();
    const handler = vi.fn(async () => {
      // handler stub
    });

    router.registerMethod('session.listTools', 'tools', handler);

    const msg = buildRequest({
      id: 'req_tools',
      session_id: 'ses_abc',
      method: 'session.listTools',
    });
    await router.dispatch(msg, transport);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('routes steer to conversation channel', async () => {
    const sm = createFakeSessionManager();
    sm.sessions.set('ses_abc', { sessionId: 'ses_abc' });
    const router = new RequestRouter({ sessionManager: sm });
    const transport = createFakeTransport();
    const handler = vi.fn(async () => {
      // handler stub
    });

    router.registerMethod('session.steer', 'conversation', handler);

    const msg = buildRequest({
      id: 'req_steer',
      session_id: 'ses_abc',
      method: 'session.steer',
      data: { input: 'focus on tests' },
    });
    await router.dispatch(msg, transport);

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
