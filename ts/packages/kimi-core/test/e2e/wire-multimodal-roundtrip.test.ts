/**
 * Phase 17 A.7 — multimodal session.prompt → kosong round-trip.
 *
 * `SessionPromptRequestData.input` is already widened to
 * `string | UserInputPart[]` (Phase 14). What Phase 17 adds:
 *   - `WiredContextState.appendUserMessage(input)` for non-text parts
 *     preserves the content-part array in the UserMessage.content
 *     (today it flattens to a string via default-handlers).
 *   - `ContextState.buildMessages()` returns UserMessage.content as
 *     `ContentPart[]` for multimodal turns.
 *   - `KosongAdapter.chat({messages})` receives the array directly;
 *     kosong-side is expected to pass it to the provider unchanged.
 *
 * Coverage:
 *   - text+image input → kosong.calls[0].messages last entry has
 *     content: [{type:"text"}, {type:"image_url"}]
 *   - pure text input → legacy string content preserved (no regression)
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildInitializeRequest,
  buildSessionCreateRequest,
  createWireE2EHarness,
  FakeKosongAdapter,
  type WireE2EInMemoryHarness,
} from '../helpers/index.js';
import { createWireRequest } from '../../src/wire-protocol/message-factory.js';
import { installWireEventBridge } from '../../src/wire-protocol/event-bridge.js';

let harness: WireE2EInMemoryHarness | undefined;
let disposeBridge: (() => void) | undefined;

afterEach(async () => {
  disposeBridge?.();
  disposeBridge = undefined;
  if (harness !== undefined) {
    await harness.dispose();
    harness = undefined;
  }
});

async function bootSession(kosong: FakeKosongAdapter): Promise<string> {
  harness = await createWireE2EHarness({ kosong });
  await harness.send(buildInitializeRequest());
  const createReq = buildSessionCreateRequest({ model: 'test-model' });
  await harness.send(createReq);
  const { response } = await harness.collectUntilResponse(createReq.id);
  const sessionId = (response.data as { session_id: string }).session_id;

  const managed = harness.sessionManager.get(sessionId);
  if (managed === undefined) throw new Error('session not materialised');
  const turnManager = managed.soulPlus.getTurnManager();
  const bridge = installWireEventBridge({
    server: harness.server,
    eventBus: harness.eventBus,
    addTurnLifecycleListener: (l) => turnManager.addTurnLifecycleListener(l),
    sessionId,
  });
  disposeBridge = bridge.dispose;
  return sessionId;
}

describe('Phase 17 A.7 — multimodal round-trip', () => {
  it('text + image_url parts land on kosong as ContentPart[] (not flattened to string)', async () => {
    const kosong = new FakeKosongAdapter({
      turns: [{ text: 'ok', stopReason: 'end_turn' }],
    });
    const sessionId = await bootSession(kosong);

    const req = createWireRequest({
      method: 'session.prompt',
      sessionId,
      data: {
        input: [
          { type: 'text', text: 'What is in this image?' },
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
            },
          },
        ],
      },
    });
    await harness!.send(req);
    const { response } = await harness!.collectUntilResponse(req.id);
    const turnId = (response.data as { turn_id: string }).turn_id;
    await harness!.expectEvent('turn.end', {
      matcher: (m) => (m.data as { turn_id: string }).turn_id === turnId,
    });

    expect(kosong.calls.length).toBeGreaterThan(0);
    const firstCall = kosong.calls[0]!;
    const messages = firstCall.messages;
    const lastUser = [...messages]
      .reverse()
      .find((m) => (m as { role?: string }).role === 'user');
    expect(lastUser).toBeDefined();
    const content = (lastUser as { content: unknown }).content;
    // Array shape — NOT collapsed to a string.
    expect(Array.isArray(content)).toBe(true);
    const arr = content as Array<{ type: string }>;
    const kinds = arr.map((p) => p.type);
    expect(kinds).toContain('text');
    expect(kinds).toContain('image_url');
  });

  it('pure text input keeps legacy string UserMessage.content (no regression)', async () => {
    const kosong = new FakeKosongAdapter({
      turns: [{ text: 'ok', stopReason: 'end_turn' }],
    });
    const sessionId = await bootSession(kosong);

    const req = createWireRequest({
      method: 'session.prompt',
      sessionId,
      data: { input: 'hello plain text' },
    });
    await harness!.send(req);
    const { response } = await harness!.collectUntilResponse(req.id);
    const turnId = (response.data as { turn_id: string }).turn_id;
    await harness!.expectEvent('turn.end', {
      matcher: (m) => (m.data as { turn_id: string }).turn_id === turnId,
    });

    const firstCall = kosong.calls[0]!;
    const lastUser = [...firstCall.messages]
      .reverse()
      .find((m) => (m as { role?: string }).role === 'user');
    const content = (lastUser as { content: unknown }).content;
    expect(typeof content === 'string' || Array.isArray(content)).toBe(true);
    if (typeof content === 'string') {
      expect(content).toContain('hello plain text');
    } else {
      // If implementer chose to always normalise to array form, the
      // first text part must still contain the original string.
      const firstText = (content as Array<{ type: string; text?: string }>).find(
        (p) => p.type === 'text',
      );
      expect(firstText?.text).toContain('hello plain text');
    }
  });
});
