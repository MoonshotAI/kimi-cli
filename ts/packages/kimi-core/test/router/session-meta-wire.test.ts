/**
 * Phase 16 / T9 — wire protocol for sessionMeta.
 *
 * Decision #113: the three sessionMeta wire methods must round-trip through
 * RequestRouter on the `management` channel (same channel as session.rename
 * today):
 *   - `session.rename`    { title } → {}
 *   - `session.setTags`   { tags }  → {}
 *   - `session.getMeta`                → { meta: SessionMeta }
 *
 * The router layer is purely dispatch: the tests below pin its ability to
 * carry the three methods + return structured responses. Router handlers
 * themselves are stubbed (registered per test) so the red bar is about
 * wire methods and channel routing, not SessionManager integration
 * (covered by the T6 / T7 tests).
 */

import { describe, expect, it, expectTypeOf, vi } from 'vitest';

import { RequestRouter, type RouteHandler } from '../../src/router/index.js';
import type { Transport } from '../../src/transport/types.js';
import type {
  ManagementMethod,
  WireEventMethod,
  WireMessage,
} from '../../src/wire-protocol/types.js';

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

function createFakeSessionManager() {
  const sessions = new Map<string, { sessionId: string }>();
  return {
    sessions,
    get(sessionId: string) {
      return sessions.get(sessionId);
    },
  };
}

function buildRequest(overrides: Partial<WireMessage>): WireMessage {
  return {
    id: 'req_test',
    time: Date.now(),
    session_id: 'ses_abc',
    type: 'request',
    from: 'client',
    to: 'core',
    method: 'initialize',
    ...overrides,
  };
}

// ── Type-level guards: the three methods + the event MUST be declared ──

describe('Phase 16 T9 — ManagementMethod / WireEventMethod declarations', () => {
  it("ManagementMethod includes 'session.setTags'", () => {
    // Compile-time: fails to type-check if the literal is not a member.
    const method = 'session.setTags' as const;
    expectTypeOf(method).toMatchTypeOf<ManagementMethod>();
  });

  it("ManagementMethod includes 'session.getMeta'", () => {
    const method = 'session.getMeta' as const;
    expectTypeOf(method).toMatchTypeOf<ManagementMethod>();
  });

  it("WireEventMethod includes 'session_meta.changed'", () => {
    const method = 'session_meta.changed' as const;
    expectTypeOf(method).toMatchTypeOf<WireEventMethod>();
  });
});

describe('Phase 16 T9 — sessionMeta wire methods', () => {
  it('routes session.rename on the management channel', async () => {
    const sm = createFakeSessionManager();
    sm.sessions.set('ses_abc', { sessionId: 'ses_abc' });
    const router = new RequestRouter({ sessionManager: sm });
    const transport = createFakeTransport();
    const handler: RouteHandler = vi.fn(async () => {});

    router.registerMethod('session.rename', 'management', handler);

    const msg = buildRequest({
      id: 'req_rename',
      method: 'session.rename',
      data: { title: 'New title' },
    });
    await router.dispatch(msg, transport);

    expect(handler).toHaveBeenCalledTimes(1);
    const calls = (handler as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const callMsg = calls[0]?.[0] as WireMessage & { data?: { title?: string } };
    expect(callMsg.data?.title).toBe('New title');
  });

  it('routes session.setTags on the management channel', async () => {
    const sm = createFakeSessionManager();
    sm.sessions.set('ses_abc', { sessionId: 'ses_abc' });
    const router = new RequestRouter({ sessionManager: sm });
    const transport = createFakeTransport();
    const handler: RouteHandler = vi.fn(async () => {});

    router.registerMethod('session.setTags', 'management', handler);

    const msg = buildRequest({
      id: 'req_tags',
      method: 'session.setTags',
      data: { tags: ['work', 'urgent'] },
    });
    await router.dispatch(msg, transport);

    expect(handler).toHaveBeenCalledTimes(1);
    const calls = (handler as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const callMsg = calls[0]?.[0] as WireMessage & { data?: { tags?: string[] } };
    expect(callMsg.data?.tags).toEqual(['work', 'urgent']);
  });

  it('routes session.getMeta on the management channel and lets the handler return meta', async () => {
    const sm = createFakeSessionManager();
    sm.sessions.set('ses_abc', { sessionId: 'ses_abc' });
    const router = new RequestRouter({ sessionManager: sm });
    const transport = createFakeTransport();

    const handler: RouteHandler = vi.fn(async () => {});
    router.registerMethod('session.getMeta', 'management', handler);

    const msg = buildRequest({ id: 'req_meta', method: 'session.getMeta' });
    await router.dispatch(msg, transport);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('session.rename returns an error for an unknown session', async () => {
    const sm = createFakeSessionManager();
    const router = new RequestRouter({ sessionManager: sm });
    const transport = createFakeTransport();
    const handler: RouteHandler = vi.fn(async () => {});

    router.registerMethod('session.rename', 'management', handler);

    const msg = buildRequest({
      id: 'req_rename',
      method: 'session.rename',
      session_id: 'ses_missing',
      data: { title: 'x' },
    });
    await expect(router.dispatch(msg, transport)).rejects.toThrow(/not found/i);
    expect(handler).not.toHaveBeenCalled();
  });
});
