/**
 * Self-test — in-memory wire harness (Phase 9 §4 + Review M1).
 *
 * The harness boots a real SessionManager + RequestRouter + default
 * handler set. Tests drive it via the same Wire envelopes a real
 * client would send; they do **not** hand-register handlers except
 * when stress-testing reverse-RPC or routerOverrides.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildApprovalResponse,
  buildInitializeRequest,
  buildPromptRequest,
  buildSessionCreateRequest,
  createWireE2EHarness,
  FakeKosongAdapter,
  type WireE2EInMemoryHarness,
} from '../helpers/index.js';
import {
  createWireRequest,
  createWireResponse,
} from '../../src/wire-protocol/message-factory.js';

const harnesses: WireE2EInMemoryHarness[] = [];
afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.dispose();
  }
});

describe('createWireE2EHarness — full initialize → session.create → session.prompt flow', () => {
  it('initialize returns capability advertisement', async () => {
    const harness = await createWireE2EHarness();
    harnesses.push(harness);
    const init = buildInitializeRequest();
    const collectPromise = harness.collectUntilResponse(init.id, { timeoutMs: 2_000 });
    await harness.send(init);
    const { response } = await collectPromise;
    expect(response.type).toBe('response');
    const data = response.data as { protocol_version: string; capabilities: { methods: string[] } };
    expect(data.protocol_version).toBeDefined();
    expect(data.capabilities.methods).toContain('session.create');
    expect(data.capabilities.methods).toContain('session.prompt');
  });

  it('session.create → session.prompt round-trips', async () => {
    const kosong = new FakeKosongAdapter().script({
      text: 'hi there',
      stopReason: 'end_turn',
    });
    const harness = await createWireE2EHarness({ kosong });
    harnesses.push(harness);

    const createReq = buildSessionCreateRequest({ model: 'test-m' });
    const createP = harness.collectUntilResponse(createReq.id, { timeoutMs: 2_000 });
    await harness.send(createReq);
    const { response: createResp } = await createP;
    const sessionId = (createResp.data as { session_id: string }).session_id;
    expect(sessionId).toMatch(/^ses_/);

    const promptReq = buildPromptRequest({ sessionId, text: 'hi' });
    const promptP = harness.collectUntilResponse(promptReq.id, { timeoutMs: 2_000 });
    await harness.send(promptReq);
    const { response: promptResp } = await promptP;
    expect(promptResp.type).toBe('response');
    expect(promptResp.data).toEqual(expect.objectContaining({ status: 'started' }));
  });
});

describe('createWireE2EHarness — lower-level contracts', () => {
  it('expectEvent resolves when the server emits an event', async () => {
    const harness = await createWireE2EHarness();
    harnesses.push(harness);
    // Simulate an event coming from server → client.
    queueMicrotask(() => {
      const evt = createWireResponse({
        requestId: 'res_fake',
        sessionId: '__process__',
        data: {},
      });
      // Wrong — we want an event not a response. Build it directly:
      void evt;
      const event = {
        id: 'evt_test1',
        time: Date.now(),
        session_id: '__process__',
        type: 'event' as const,
        from: 'core',
        to: 'client',
        method: 'turn.begin',
        seq: 1,
      };
      void harness.server.send(JSON.stringify(event));
    });
    const got = await harness.expectEvent('turn.begin', { timeoutMs: 2_000 });
    expect(got.type).toBe('event');
    expect(got.method).toBe('turn.begin');
  });

  it('collectUntilResponse auto-replies to reverse-RPC requests and strips the terminating response from events', async () => {
    const harness = await createWireE2EHarness({
      routerOverrides: (router) => {
        // Override session.prompt to exercise the reverse-RPC + response path.
        router.registerMethod(
          'session.prompt',
          'conversation',
          async (msg) => {
            const revReq = createWireRequest({
              method: 'approval.request',
              sessionId: msg.session_id,
              data: { tool: 'Bash' },
            });
            await harness.server.send(JSON.stringify(revReq));
            queueMicrotask(() => {
              const evt = createWireResponse({
                requestId: msg.id,
                sessionId: msg.session_id,
                data: { turn_id: 't_1', status: 'started' },
              });
              void harness.server.send(JSON.stringify(evt));
            });
          },
        );
      },
    });
    harnesses.push(harness);

    // We still need a real session so the router's session-channel
    // lookup succeeds. Use the default handlers to allocate one.
    const createReq = buildSessionCreateRequest({ model: 'test-m' });
    const createP = harness.collectUntilResponse(createReq.id, { timeoutMs: 2_000 });
    await harness.send(createReq);
    const { response: createResp } = await createP;
    const sessionId = (createResp.data as { session_id: string }).session_id;

    const prompt = buildPromptRequest({ sessionId, text: 'hi' });
    const collectPromise = harness.collectUntilResponse(prompt.id, {
      timeoutMs: 2_000,
      requestHandler: (req) => buildApprovalResponse(req, 'approved'),
    });
    await harness.send(prompt);
    const { response, events } = await collectPromise;
    expect(response.type).toBe('response');
    expect(events.some((m) => m.type === 'request')).toBe(true);
    // M4: response itself must not appear in `events`.
    expect(events.every((m) => m.id !== response.id)).toBe(true);
  });

  it('times out cleanly with method + request id in the error message', async () => {
    const harness = await createWireE2EHarness();
    harnesses.push(harness);
    await expect(
      harness.expectEvent('nothing.ever.fires', { timeoutMs: 150 }),
    ).rejects.toThrow(/event 'nothing\.ever\.fires'.*timed out after 150ms/);
  });

  it('dispose is idempotent and cleans temp dirs', async () => {
    const { existsSync } = await import('node:fs');
    const harness = await createWireE2EHarness();
    const workDir = harness.workDir;
    expect(existsSync(workDir)).toBe(true);
    await harness.dispose();
    // Second call must not throw.
    await harness.dispose();
    expect(existsSync(workDir)).toBe(false);
  });

  it('R2-1: dispatch errors come back as wire error responses (not hangs)', async () => {
    const harness = await createWireE2EHarness();
    harnesses.push(harness);

    // Method not found — process-level.
    const bogus = createWireRequest({
      method: 'does.not.exist',
      sessionId: '__process__',
    });
    const waitMnf = harness.collectUntilResponse(bogus.id, { timeoutMs: 2_000 });
    await harness.send(bogus);
    const { response: mnfResponse } = await waitMnf;
    expect(mnfResponse.error).toBeDefined();
    expect(mnfResponse.error?.code).toBe(-32601);

    // Session not found — session-scoped request against a missing id.
    const sessionMissing = createWireRequest({
      method: 'session.prompt',
      sessionId: 'ses_does_not_exist',
      data: { input: 'x' },
    });
    const waitSnf = harness.collectUntilResponse(sessionMissing.id, { timeoutMs: 2_000 });
    await harness.send(sessionMissing);
    const { response: snfResponse } = await waitSnf;
    expect(snfResponse.error).toBeDefined();
    expect(snfResponse.error?.code).toBe(-32000);
  });
});
