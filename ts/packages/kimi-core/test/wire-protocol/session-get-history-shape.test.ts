/**
 * Slice 20-B R-4 — `session.getHistory` type pollution removal.
 *
 * The current handler writes:
 *   data: { messages: history as unknown as readonly unknown[] }
 * The double-cast ( `as unknown as` ) bypasses TS's structural check
 * because `SessionGetHistoryResponseData.messages` is typed as
 * `unknown[]` — so `getHistory(): readonly Message[]` would otherwise
 * collide with `unknown[]`'s mutability expectation.
 *
 * The Phase 20 §C.2 fix is a pure type narrowing (not a Zod runtime
 * validator — `getHistory()` is already typed; the cast only exists to
 * work around the loose response shape):
 *
 *   1. `SessionGetHistoryResponseData.messages: readonly Message[]`
 *      (narrowed from `unknown[]`).
 *   2. Handler drops the double-cast: `data: { messages: history }`.
 *
 * Red bars below:
 *   - Runtime: a happy-path call to `session.getHistory` yields a
 *     response whose `messages` field is an array of **Message-shaped**
 *     entries (each with a `role` ∈ {user, assistant, system, tool} and
 *     a `content` array), not a bag of `unknown`.
 *   - Source text sentinel: the handler source no longer contains the
 *     `as unknown as readonly unknown[]` escape hatch.
 *
 * Out of scope (per Phase 20 doc + design v2-update):
 *   - Zod runtime validation on outbound data. Outbound is already
 *     typed end-to-end; only the inbound side (request validation) uses
 *     Zod.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildInitializeRequest,
  buildPromptRequest,
  buildSessionCreateRequest,
  createTestApproval,
  createWireE2EHarness,
  FakeKosongAdapter,
  type WireE2EInMemoryHarness,
} from '../helpers/index.js';
import type {
  SessionGetHistoryResponseData,
  WireMessage,
} from '../../src/wire-protocol/types.js';

const HANDLER_PATH = resolve(
  import.meta.dirname,
  '../../src/wire-protocol/default-handlers.ts',
);

let harness: WireE2EInMemoryHarness | undefined;

afterEach(async () => {
  if (harness !== undefined) {
    await harness.dispose();
    harness = undefined;
  }
});

// ── 1. Source sentinel — the escape hatch is gone ──────────────────────

describe('Phase 20 R-4 — default-handlers.ts sentinel', () => {
  it('does not use `as unknown as` anywhere in the file', () => {
    const src = readFileSync(HANDLER_PATH, 'utf8');
    // Regex guards against both `as unknown as readonly unknown[]` and
    // any minor re-writes that keep the double-cast shape.
    expect(src).not.toMatch(/as\s+unknown\s+as\b/);
  });
});

// ── 2. Runtime shape — messages are typed ──────────────────────────────

async function bootAndPrompt(): Promise<{ sessionId: string }> {
  const kosong = new FakeKosongAdapter().script({
    text: 'hi there',
    stopReason: 'end_turn',
  });
  const approval = createTestApproval({ yolo: true });
  harness = await createWireE2EHarness({ kosong, approval });

  const init = buildInitializeRequest();
  await harness.send(init);
  await harness.collectUntilResponse(init.id);

  const create = buildSessionCreateRequest({ model: 'test-model' });
  await harness.send(create);
  const { response: created } = await harness.collectUntilResponse(create.id);
  const sessionId = (created.data as { session_id: string }).session_id;

  const prompt = buildPromptRequest({ sessionId, text: 'say hi' });
  await harness.send(prompt);
  await harness.collectUntilResponse(prompt.id);

  return { sessionId };
}

async function request(
  method: string,
  sessionId: string,
  data: unknown,
): Promise<WireMessage> {
  if (harness === undefined) throw new Error('harness not booted');
  return harness.request(method, data, { sessionId });
}

describe('Phase 20 R-4 — session.getHistory response is Message-shaped', () => {
  it('messages is an array of Message records, not bags of unknown', async () => {
    const { sessionId } = await bootAndPrompt();
    const resp = await request('session.getHistory', sessionId, {});

    expect(resp.error).toBeUndefined();
    const data = resp.data as SessionGetHistoryResponseData;
    expect(Array.isArray(data.messages)).toBe(true);
    expect(data.messages.length).toBeGreaterThan(0);

    for (const msg of data.messages) {
      // Post-R-4 the type narrowing means each entry carries at least
      // `role` + `content`; the test pins both so the old `unknown[]`
      // typing can't satisfy it implicitly.
      const m = msg as { role?: unknown; content?: unknown };
      expect(typeof m.role).toBe('string');
      expect(['user', 'assistant', 'system', 'tool']).toContain(m.role);
      expect(Array.isArray(m.content)).toBe(true);
    }
  });
});

// ── 3. Compile-time narrowing assertion ────────────────────────────────
//
// After R-4, `SessionGetHistoryResponseData.messages` is `readonly Message[]`.
// This function is a compile-time structural guard: body never runs, TS
// checks at typecheck. Access of `.role` must compile without cast.

function _messagesAreTyped(r: SessionGetHistoryResponseData): void {
  const role: string = r.messages[0]!.role;
  void role;
}
void _messagesAreTyped;
