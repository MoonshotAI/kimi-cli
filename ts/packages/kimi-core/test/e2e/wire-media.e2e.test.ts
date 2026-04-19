/**
 * Wire E2E — scripted-echo media prompts (Phase 14 §4.1).
 *
 * Migrated from `/Users/moonshot/Developer/kimi-cli/tests/e2e/test_media_e2e.py`:
 *   - test_scripted_echo_media_e2e(mode='wire', image_url)
 *   - test_scripted_echo_media_e2e(mode='wire', video_url)
 *
 * The Python suite runs `print` and `wire` modes in one parametrised
 * test; Phase 14 migrates only the wire path (print mode is pushed to
 * the CLI Phase — see phase doc §4.1).
 *
 * Phase 14 §3.5 widens `SessionPromptRequestData.input` to
 *   `string | readonly UserInputPart[]`
 * where `UserInputPart = TextPart | ImageURLPart | VideoURLPart`.
 * Until that widening lands, the request builder below constructs the
 * array shape manually — on purpose — so the tests FAIL at the
 * serializer level rather than silently coercing to string.
 *
 * The test also depends on `TurnBeginEventData.user_input` widening
 * from `string` to the same union (so we can assert the image_url /
 * video_url part survives the round-trip).
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
import type { WireMessage } from '../../src/wire-protocol/index.js';
import {
  parseScriptedEchoText,
} from '../helpers/wire/scripted-echo-provider.js';
import { installWireEventBridge } from './helpers/wire-event-bridge.js';

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

function eventsOfMethod(events: readonly WireMessage[], method: string): readonly WireMessage[] {
  return events.filter((e) => e.type === 'event' && e.method === method);
}

function hasUserInputPartType(events: readonly WireMessage[], partType: string): boolean {
  for (const e of eventsOfMethod(events, 'turn.begin')) {
    // Phase 14 §3.5: `user_input` widens from string to UserInputPart[].
    const payload = e.data as { user_input?: unknown };
    const input = payload?.user_input;
    if (Array.isArray(input)) {
      for (const part of input) {
        if (typeof part === 'object' && part !== null) {
          const p = part as { type?: string };
          if (p.type === partType) return true;
        }
      }
    }
  }
  return false;
}

function hasContentDeltaType(
  events: readonly WireMessage[],
  type: 'text' | 'thinking',
): boolean {
  for (const e of eventsOfMethod(events, 'content.delta')) {
    const payload = e.data as { type?: string };
    if (payload?.type === type) return true;
  }
  return false;
}

function hasContentDeltaText(events: readonly WireMessage[], needle: string): boolean {
  for (const e of eventsOfMethod(events, 'content.delta')) {
    const payload = e.data as { type?: string; text?: string };
    if (payload?.type === 'text' && typeof payload.text === 'string' && payload.text.includes(needle)) {
      return true;
    }
  }
  return false;
}

async function bootSession(kosong: FakeKosongAdapter): Promise<{ sessionId: string }> {
  harness = await createWireE2EHarness({ kosong });
  await harness.send(buildInitializeRequest());

  const createReq = buildSessionCreateRequest({ model: 'test-model' });
  await harness.send(createReq);
  const { response } = await harness.collectUntilResponse(createReq.id);
  const sessionId = (response.data as { session_id: string }).session_id;

  // Phase 14 §4.1 test-helper parity — `createWireE2EHarness` only
  // round-trips requests; lifecycle events need the test-local bridge
  // to reach the wire queue. Mirrors `wire-prompt.test.ts:60-69`.
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

  return { sessionId };
}

/**
 * Phase 14 §3.5 — request builder producing the widened shape.
 * Hand-rolls the frame so the tests exercise the new contract
 * directly without relying on a convenience builder that may still
 * coerce to string.
 */
function buildPromptRequestWithParts(
  sessionId: string,
  parts: readonly Record<string, unknown>[],
): WireMessage {
  return createWireRequest({
    method: 'session.prompt',
    sessionId,
    data: { input: parts },
  });
}

describe('wire e2e — scripted-echo media (Phase 14 §4.1)', () => {
  it('image: turn.begin carries image_url part + content delta emits think + text', async () => {
    const imageUrl = 'data:image/png;base64,AAAA';
    const imageScript = parseScriptedEchoText(
      [
        'id: scripted-1',
        'usage: {"input_other": 11, "output": 5}',
        'think: analyzing the image',
        'text: The image shows a simple scene.',
      ].join('\n'),
    );

    const kosong = new FakeKosongAdapter({ turns: [imageScript] });
    const { sessionId } = await bootSession(kosong);

    const req = buildPromptRequestWithParts(sessionId, [
      { type: 'text', text: 'Describe this image.' },
      { type: 'image_url', image_url: { url: imageUrl } },
    ]);
    await harness!.send(req);

    const { response } = await harness!.collectUntilResponse(req.id, {
      timeoutMs: 10_000,
    });

    // Status line returns `turn_id` + `status: "started"` (non-blocking).
    expect(response.type).toBe('response');
    const status = response.data as { status?: string; turn_id?: string };
    expect(status.status).toBe('started');

    // Phase 25 Stage C — slice 25c-2 adds an `await appendStepBegin` hop
    // before `kosong.chat`, so content.delta / thinking.delta can land
    // after the `status: 'started'` response. Wait for terminal
    // `turn.end` (mirrors the pattern in `wire-prompt.test.ts`) and
    // inspect the full received frame buffer.
    await harness!.expectEvent('turn.end', {
      matcher: (m) => (m.data as { turn_id?: string }).turn_id === status.turn_id,
      timeoutMs: 10_000,
    });
    const frames = harness!.received;

    expect(hasUserInputPartType(frames, 'image_url')).toBe(true);
    expect(hasContentDeltaType(frames, 'thinking')).toBe(true);
    expect(hasContentDeltaText(frames, 'The image shows a simple scene.')).toBe(true);
  });

  it('video: turn.begin carries video_url part + content delta emits think + text', async () => {
    const videoUrl = 'data:video/mp4;base64,AAAA';
    const videoScript = parseScriptedEchoText(
      [
        'id: scripted-2',
        'usage: {"input_other": 13, "output": 6}',
        'think: analyzing the video',
        'text: The video appears to be a short clip.',
      ].join('\n'),
    );

    const kosong = new FakeKosongAdapter({ turns: [videoScript] });
    const { sessionId } = await bootSession(kosong);

    const req = buildPromptRequestWithParts(sessionId, [
      { type: 'text', text: 'Describe this video.' },
      { type: 'video_url', video_url: { url: videoUrl } },
    ]);
    await harness!.send(req);

    const { response } = await harness!.collectUntilResponse(req.id, {
      timeoutMs: 10_000,
    });
    expect(response.type).toBe('response');
    const status = response.data as { status?: string; turn_id?: string };
    expect(status.status).toBe('started');

    // See image-test note above — wait for terminal `turn.end` before
    // scanning the received buffer.
    await harness!.expectEvent('turn.end', {
      matcher: (m) => (m.data as { turn_id?: string }).turn_id === status.turn_id,
      timeoutMs: 10_000,
    });
    const frames = harness!.received;

    expect(hasUserInputPartType(frames, 'video_url')).toBe(true);
    expect(hasContentDeltaType(frames, 'thinking')).toBe(true);
    expect(hasContentDeltaText(frames, 'The video appears to be a short clip.')).toBe(true);
  });
});
