/**
 * SessionMetaService — T3 (state.json debounced flush).
 *
 * Phase 16 / todo §测试重点 T3:
 *   - back-to-back writes inside the debounce window land as ONE state.json
 *     atomicWrite
 *   - flushPending() bypasses the timer and writes immediately
 *   - a failing atomicWrite does not propagate out of the debounced path
 *
 * Uses real timers with a tiny debounce window (10–20ms). Fake timers are
 * incompatible with the service's async pre-write `stateCache.read()`
 * (libuv fs I/O does not drain on `advanceTimersByTimeAsync`), so the
 * test waits for real wall-clock elapsed time.
 */

import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionEventBus } from '../../src/soul-plus/session-event-bus.js';
import {
  SessionMetaService,
  type SessionMeta,
} from '../../src/soul-plus/session-meta-service.js';
import { StateCache, type SessionState } from '../../src/session/state-cache.js';
import type { JournalInput } from '../../src/storage/wire-record.js';

class SpySessionJournal {
  readonly appended: Array<JournalInput<'session_meta_changed'>> = [];
  async appendSessionMetaChanged(data: JournalInput<'session_meta_changed'>): Promise<void> {
    this.appended.push(data);
  }
}

class SpyStateCache extends StateCache {
  writes = 0;
  shouldFail = false;
  lastWritten: SessionState | undefined;

  override async write(state: SessionState): Promise<void> {
    this.writes++;
    this.lastWritten = state;
    if (this.shouldFail) {
      throw new Error('simulated atomicWrite failure');
    }
    await super.write(state);
  }
}

interface Harness {
  service: SessionMetaService;
  journal: SpySessionJournal;
  stateCache: SpyStateCache;
  statePath: string;
  tmp: string;
}

async function makeHarness(opts: { flushDebounceMs?: number } = {}): Promise<Harness> {
  const tmp = join(
    tmpdir(),
    `kimi-meta-flush-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tmp, { recursive: true });
  const statePath = join(tmp, 'state.json');
  const stateCache = new SpyStateCache(statePath);
  const journal = new SpySessionJournal();
  const eventBus = new SessionEventBus();
  const initialMeta: SessionMeta = {
    session_id: 'ses_flush',
    created_at: Date.now(),
    turn_count: 0,
    last_updated: Date.now(),
  };
  const service = new SessionMetaService({
    sessionId: 'ses_flush',
    sessionJournal: journal as unknown as ConstructorParameters<
      typeof SessionMetaService
    >[0]['sessionJournal'],
    eventBus,
    stateCache,
    initialMeta,
    ...(opts.flushDebounceMs !== undefined ? { flushDebounceMs: opts.flushDebounceMs } : {}),
  });
  return { service, journal, stateCache, statePath, tmp };
}

const cleanupPaths: string[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  cleanupPaths.length = 0;
});

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

describe('SessionMetaService.scheduleStateFlush — T3', () => {
  it('coalesces multiple writes inside the debounce window into a single atomicWrite', async () => {
    const h = await makeHarness({ flushDebounceMs: 25 });
    cleanupPaths.push(h.tmp);
    await h.service.setTitle('t-1', 'user');
    await h.service.setTitle('t-2', 'user');
    await h.service.setTitle('t-3', 'user');
    await h.service.setTitle('t-4', 'user');
    await h.service.setTitle('t-5', 'user');

    // Before the debounce elapses, NO state.json write should have landed.
    expect(h.stateCache.writes).toBe(0);

    await sleep(60);
    // Exactly one write; the last title wins.
    expect(h.stateCache.writes).toBe(1);
    expect((h.stateCache.lastWritten as { custom_title?: string }).custom_title).toBe('t-5');
  });

  it('flushPending() writes immediately and clears the pending timer', async () => {
    const h = await makeHarness({ flushDebounceMs: 200 });
    cleanupPaths.push(h.tmp);
    await h.service.setTitle('immediate', 'user');
    expect(h.stateCache.writes).toBe(0); // still debounced
    await h.service.flushPending();
    expect(h.stateCache.writes).toBe(1);

    // No stray flush fires afterwards.
    await sleep(250);
    expect(h.stateCache.writes).toBe(1);
  });

  it('swallows atomicWrite failures during the debounced flush', async () => {
    const h = await makeHarness({ flushDebounceMs: 15 });
    cleanupPaths.push(h.tmp);
    h.stateCache.shouldFail = true;
    await h.service.setTitle('will-fail', 'user');
    await sleep(50);
    expect(h.stateCache.writes).toBe(1);

    // A subsequent write after clearing the failure mode should succeed —
    // no "stuck timer" left behind.
    h.stateCache.shouldFail = false;
    await h.service.setTitle('retry-ok', 'user');
    await sleep(50);
    expect(h.stateCache.writes).toBe(2);
  });

  it('writes into state.json on disk (end-to-end, real StateCache)', async () => {
    const h = await makeHarness({ flushDebounceMs: 25 });
    cleanupPaths.push(h.tmp);
    await h.service.setTitle('on-disk', 'user');
    await h.service.flushPending();
    const raw = await readFile(h.statePath, 'utf-8');
    const parsed = JSON.parse(raw) as { custom_title?: string };
    expect(parsed.custom_title).toBe('on-disk');
    // state.json must actually exist as a regular file.
    const st = await stat(h.statePath);
    expect(st.isFile()).toBe(true);
  });
});
