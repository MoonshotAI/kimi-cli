/**
 * Covers: `SoulPlus.dispatch` routing (v2 §5.2 / §5.4 — conversation
 * channel subset).
 *
 * Slice 3 only routes the three conversation methods
 * (`session.prompt` / `session.cancel` / `session.steer`). Anything else
 * returns `{error: 'method_not_found'}`. Ownership checks, 5-channel
 * routing, transactional handlers, and approval are Slice 5 / Slice 8.
 */

import { describe, expect, it } from 'vitest';

import {
  SessionEventBus,
  SoulPlus,
  createRuntime,
  type DispatchRequest,
} from '../../src/soul-plus/index.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import { makeEndTurnResponse } from '../soul/fixtures/common.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';
import {
  createHarnessContextState,
  createNoopCompactionProvider,
  createNoopJournalCapability,
  createSpyLifecycleGate,
} from './fixtures/slice3-harness.js';

function buildSoulPlus(kosong?: ScriptedKosongAdapter): SoulPlus {
  const contextState = createHarnessContextState();
  const sessionJournal = new InMemorySessionJournalImpl();
  const runtime = createRuntime({
    kosong: kosong ?? new ScriptedKosongAdapter({ responses: [makeEndTurnResponse('ok')] }),
    lifecycle: createSpyLifecycleGate(),
    compactionProvider: createNoopCompactionProvider(),
    journal: createNoopJournalCapability(),
  });
  const eventBus = new SessionEventBus();
  return new SoulPlus({
    sessionId: 'ses_test',
    contextState,
    sessionJournal,
    runtime,
    eventBus,
    tools: [],
  });
}

describe('SoulPlus.dispatch', () => {
  it('exposes the sessionId via a read-only accessor', () => {
    const soulPlus = buildSoulPlus();
    expect(soulPlus.sessionId).toBe('ses_test');
  });

  it('routes session.prompt to the prompt handler and returns {turn_id, status:"started"}', async () => {
    const soulPlus = buildSoulPlus(
      new ScriptedKosongAdapter({ responses: [makeEndTurnResponse('hi')] }),
    );
    const request: DispatchRequest = {
      method: 'session.prompt',
      data: { input: { text: 'hello' } },
    };
    const response = await soulPlus.dispatch(request);
    expect(response).toMatchObject({ status: 'started' });
    if (!('turn_id' in response)) {
      throw new Error('expected turn_id');
    }
    expect(typeof response.turn_id).toBe('string');
  });

  it('routes session.cancel to the cancel handler', async () => {
    const soulPlus = buildSoulPlus(
      new ScriptedKosongAdapter({
        responses: [makeEndTurnResponse('never')],
        delayMs: 500,
      }),
    );
    const started = await soulPlus.dispatch({
      method: 'session.prompt',
      data: { input: { text: 'hi' } },
    });
    if (!('turn_id' in started)) throw new Error('expected turn_id');

    const cancelled = await soulPlus.dispatch({
      method: 'session.cancel',
      data: { turn_id: started.turn_id },
    });
    expect(cancelled).toBeDefined();
    expect('error' in cancelled).toBe(false);
  });

  it('routes session.steer to the steer handler', async () => {
    const soulPlus = buildSoulPlus();
    const response = await soulPlus.dispatch({
      method: 'session.steer',
      data: { input: { text: 'focus on foo' } },
    });
    expect(response).toBeDefined();
    expect('error' in response).toBe(false);
  });

  it('returns {error:"method_not_found"} for unknown methods', async () => {
    const soulPlus = buildSoulPlus();
    // cast because DispatchRequest is a closed union; we explicitly test
    // the fallback branch for an out-of-union method string.
    const badRequest = { method: 'session.unknown', data: {} } as unknown as DispatchRequest;
    const response = await soulPlus.dispatch(badRequest);
    expect(response).toHaveProperty('error');
    if ('error' in response) {
      expect(response.error).toMatch(/method_not_found|not.?found/i);
    }
  });
});
