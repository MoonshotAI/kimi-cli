/**
 * Phase 22 — SessionMetaService producer field (T6).
 *
 * SessionMeta grows a new field `producer: WireProducer`. It is passed in
 * via `initialMeta.producer` at construction (SessionManager derives it
 * from `getProducerInfo()` on create, or from `replayResult.producer` on
 * resume) and is projected into state.json via `flushStateJson`.
 *
 * `producer` is immutable — there is no `setProducer()` API. The field is
 * stamped once (at session start) and mirrors the wire metadata header for
 * the lifetime of the session.
 *
 * Covered behaviours:
 *   T6.1  initialMeta.producer round-trips through get()
 *   T6.2  flushPending() writes producer into state.json
 *   T6.3  getSessionMeta() returns undefined producer when initialMeta
 *         omits it (transitional / legacy shape — invariant for
 *         backwards-compat read path)
 *
 * Red bar until Step 6.1 (SessionMeta.producer field) lands.
 */

import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StateCache } from '../../src/session/state-cache.js';
import { SessionEventBus } from '../../src/soul-plus/session-event-bus.js';
import {
  SessionMetaService,
  type SessionMeta,
} from '../../src/soul-plus/session-meta-service.js';
import type { JournalInput } from '../../src/storage/wire-record.js';
import type { WireProducer } from '../../src/storage/wire-record.js';

// Reuse the same spy pattern as test/soul-plus/session-meta-service.test.ts
class SpySessionJournal {
  readonly appended: Array<JournalInput<'session_meta_changed'>> = [];
  async appendSessionMetaChanged(data: JournalInput<'session_meta_changed'>): Promise<void> {
    this.appended.push(data);
  }
}

function makeInitialMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    session_id: 'ses_test',
    created_at: 1_700_000_000_000,
    turn_count: 0,
    last_updated: 1_700_000_000_000,
    ...overrides,
  };
}

interface Harness {
  readonly service: SessionMetaService;
  readonly statePath: string;
  readonly tmp: string;
}

async function makeHarness(initial: Partial<SessionMeta> = {}): Promise<Harness> {
  const tmp = join(
    tmpdir(),
    `kimi-meta-producer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tmp, { recursive: true });
  const statePath = join(tmp, 'state.json');
  const stateCache = new StateCache(statePath);
  const service = new SessionMetaService({
    sessionId: 'ses_test',
    sessionJournal: new SpySessionJournal() as unknown as ConstructorParameters<
      typeof SessionMetaService
    >[0]['sessionJournal'],
    eventBus: new SessionEventBus(),
    stateCache,
    initialMeta: makeInitialMeta(initial),
  });
  return { service, statePath, tmp };
}

let harnesses: Harness[] = [];

beforeEach(() => {
  harnesses = [];
});

afterEach(async () => {
  for (const h of harnesses) {
    await rm(h.tmp, { recursive: true, force: true });
  }
  harnesses = [];
});

const TS_PRODUCER: WireProducer = {
  kind: 'typescript',
  name: '@moonshot-ai/core',
  version: '0.5.0',
};

describe('SessionMetaService — producer field (T6)', () => {
  it('initialMeta.producer round-trips through get()', async () => {
    const h = await makeHarness({ producer: TS_PRODUCER });
    harnesses.push(h);
    const meta = h.service.get();
    expect(meta.producer).toEqual(TS_PRODUCER);
  });

  it('flushPending() writes producer into state.json', async () => {
    const h = await makeHarness({ producer: TS_PRODUCER });
    harnesses.push(h);
    // Touch meta to schedule a flush (setTitle is the simplest write path).
    await h.service.setTitle('kickoff', 'system');
    await h.service.flushPending();

    const raw = await readFile(h.statePath, 'utf-8');
    const state = JSON.parse(raw) as Record<string, unknown>;
    expect(state['producer']).toEqual(TS_PRODUCER);
  });

  it('get() returns undefined producer when initialMeta omits it (legacy shape)', async () => {
    // Backwards-compat invariant: a construction site that does not
    // plumb producer (e.g. legacy test harness) must not crash — producer
    // is simply absent from the in-memory view.
    const h = await makeHarness();
    harnesses.push(h);
    const meta = h.service.get();
    expect(meta.producer).toBeUndefined();
  });
});
