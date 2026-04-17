/**
 * SessionMetaService — T1 (wire record + recover) + T2 (events + subscribers).
 *
 * Phase 16 / 决策 #113 / ADR-X.113. Tests the wire-truth write path and the
 * wire-event fan-out. Red bar until `src/soul-plus/session-meta-service.ts`
 * and the `session_meta_changed` wire record land.
 *
 * Covered behaviours (todo §测试重点):
 *   - T1.1  setTitle(..) → wire.jsonl gains one session_meta_changed record
 *   - T1.2  setTitle(..) survives a simulated crash (recoverFromReplay)
 *   - T1.3  setTags(..) uses full-replace semantics
 *   - T1.4  idempotent: setTitle with same value → no wire write
 *   - T1.5  setTitle('') / setTitle('   ') throws
 *   - T2.1  setTitle → eventBus emits 'session_meta.changed'
 *   - T2.2  subscribe(handler) fires and returns a working unsubscribe
 *   - T2.3  a throwing subscriber is isolated from peers and caller
 *   - T2.4  derived update (turn_count++) does NOT emit session_meta.changed
 */

import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionEventBus } from '../../src/soul-plus/session-event-bus.js';
import {
  SessionMetaService,
  type SessionMeta,
  type SessionMetaListener,
} from '../../src/soul-plus/session-meta-service.js';
import { StateCache } from '../../src/session/state-cache.js';
import type { JournalInput } from '../../src/storage/wire-record.js';

// ── test doubles ──────────────────────────────────────────────────────

/**
 * Fake SessionJournal-ish capture. Phase 16 extends SessionJournal with an
 * `appendSessionMetaChanged` method (todo Step 1.5 adds the record to the
 * WireRecord union; Step 2 routes SessionMetaService writes through the
 * SessionJournal window). The spy below pins the expected call shape so the
 * implementer can see exactly what the service must emit.
 */
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
  readonly journal: SpySessionJournal;
  readonly eventBus: SessionEventBus;
  readonly stateCache: StateCache;
  readonly statePath: string;
  readonly tmp: string;
}

async function buildHarness(opts: {
  initialMeta?: Partial<SessionMeta>;
  flushDebounceMs?: number;
} = {}): Promise<Harness> {
  const tmp = join(
    tmpdir(),
    `kimi-meta-svc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tmp, { recursive: true });
  const statePath = join(tmp, 'state.json');
  const stateCache = new StateCache(statePath);
  const journal = new SpySessionJournal();
  const eventBus = new SessionEventBus();
  const service = new SessionMetaService({
    sessionId: 'ses_test',
    sessionJournal: journal as unknown as ConstructorParameters<
      typeof SessionMetaService
    >[0]['sessionJournal'],
    eventBus,
    stateCache,
    initialMeta: makeInitialMeta(opts.initialMeta),
    ...(opts.flushDebounceMs !== undefined ? { flushDebounceMs: opts.flushDebounceMs } : {}),
  });
  return { service, journal, eventBus, stateCache, statePath, tmp };
}

let harnesses: Harness[] = [];

async function makeHarness(
  opts: { initialMeta?: Partial<SessionMeta>; flushDebounceMs?: number } = {},
): Promise<Harness> {
  const h = await buildHarness(opts);
  harnesses.push(h);
  return h;
}

beforeEach(() => {
  harnesses = [];
});

afterEach(async () => {
  for (const h of harnesses) {
    await rm(h.tmp, { recursive: true, force: true });
  }
  harnesses = [];
});

// ── T1 — wire record + recover ─────────────────────────────────────────

describe('SessionMetaService.setTitle (T1)', () => {
  it('appends a session_meta_changed record to the SessionJournal', async () => {
    const { service, journal } = await makeHarness();
    await service.setTitle('Fix the auth bug', 'user');
    expect(journal.appended).toHaveLength(1);
    const rec = journal.appended[0]!;
    expect(rec.type).toBe('session_meta_changed');
    expect(rec.patch.title).toBe('Fix the auth bug');
    expect(rec.source).toBe('user');
  });

  it('updates the in-memory title immediately', async () => {
    const { service } = await makeHarness();
    await service.setTitle('Demo', 'user');
    expect(service.get().title).toBe('Demo');
  });

  it('survives a simulated crash via recoverFromReplay', async () => {
    const { service } = await makeHarness();
    await service.setTitle('crash-survivor', 'user');

    // Simulate "process died, new process booting" by building a second
    // service with no initial title and feeding the replayed meta.
    const h2 = await makeHarness();
    h2.service.recoverFromReplay({ title: 'crash-survivor' });
    expect(h2.service.get().title).toBe('crash-survivor');
    void service; // keep the original reference alive until after the assertion
  });

  it('is idempotent when the same title is set twice', async () => {
    const { service, journal } = await makeHarness();
    await service.setTitle('same', 'user');
    await service.setTitle('same', 'user');
    expect(journal.appended).toHaveLength(1);
  });

  it('throws on an empty title', async () => {
    const { service, journal } = await makeHarness();
    await expect(service.setTitle('', 'user')).rejects.toThrow(/empty|invalid/i);
    expect(journal.appended).toHaveLength(0);
  });

  it('throws on a whitespace-only title', async () => {
    const { service, journal } = await makeHarness();
    await expect(service.setTitle('   ', 'user')).rejects.toThrow(/empty|invalid/i);
    expect(journal.appended).toHaveLength(0);
  });

  it('forwards the optional reason into the wire record', async () => {
    const { service, journal } = await makeHarness();
    await service.setTitle('auto-generated', 'auto', 'first-turn-synthesis');
    expect(journal.appended[0]!.reason).toBe('first-turn-synthesis');
  });
});

describe('SessionMetaService.setTags (T1 continued)', () => {
  it('writes a single wire record that carries the full tag array (replace semantics)', async () => {
    const { service, journal } = await makeHarness({
      initialMeta: { tags: ['alpha', 'beta'] },
    });
    await service.setTags(['gamma'], 'user');
    expect(journal.appended).toHaveLength(1);
    expect(journal.appended[0]!.patch.tags).toEqual(['gamma']);
    expect(service.get().tags).toEqual(['gamma']);
  });

  it('is idempotent when the tag list is unchanged', async () => {
    const { service, journal } = await makeHarness({
      initialMeta: { tags: ['x', 'y'] },
    });
    await service.setTags(['x', 'y'], 'user');
    expect(journal.appended).toHaveLength(0);
  });

  it('treats different element ordering as a change (no implicit sort)', async () => {
    const { service, journal } = await makeHarness({
      initialMeta: { tags: ['x', 'y'] },
    });
    await service.setTags(['y', 'x'], 'user');
    expect(journal.appended).toHaveLength(1);
    expect(journal.appended[0]!.patch.tags).toEqual(['y', 'x']);
  });

  it('get() returns a defensive copy of tags (external mutation cannot leak in)', async () => {
    const { service } = await makeHarness();
    await service.setTags(['a', 'b'], 'user');
    const snap = service.get().tags!;
    snap.push('mutation');
    expect(service.get().tags).toEqual(['a', 'b']);
  });
});

// ── T2 — wire events + subscribers ────────────────────────────────────

describe('SessionMetaService events (T2)', () => {
  it('emits session_meta.changed on the EventBus after a wire-truth write', async () => {
    const { service, eventBus } = await makeHarness();
    const seen: unknown[] = [];
    eventBus.on((e) => {
      if ((e as { type: string }).type === 'session_meta.changed') seen.push(e);
    });
    await service.setTitle('emit-check', 'user');
    expect(seen).toHaveLength(1);
    const ev = seen[0] as { data: { patch: { title?: string }; source: string } };
    expect(ev.data.patch.title).toBe('emit-check');
    expect(ev.data.source).toBe('user');
  });

  it('subscribe(handler) fires with the patch + source and returns a disposer', async () => {
    const { service } = await makeHarness();
    const seen: Array<Parameters<SessionMetaListener>> = [];
    const unsub = service.subscribe((patch, src) => {
      seen.push([patch, src]);
    });
    await service.setTitle('first', 'user');
    expect(seen).toHaveLength(1);
    expect(seen[0]![0].title).toBe('first');
    expect(seen[0]![1]).toBe('user');

    unsub();
    await service.setTitle('second', 'user');
    expect(seen).toHaveLength(1); // disposer worked
  });

  it('a throwing subscriber is isolated: peers still fire, caller is not surfaced', async () => {
    const { service } = await makeHarness();
    const good = vi.fn();
    service.subscribe(() => {
      throw new Error('boom');
    });
    service.subscribe(good);
    await expect(service.setTitle('isolated', 'user')).resolves.toBeUndefined();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('derived field updates do NOT produce a session_meta.changed event', async () => {
    // Derived-field updates (turn.end → turn_count++) must stay quiet on the
    // wire event channel: the UI already receives turn.end directly. Decision
    // #113 / D6 is explicit about this.
    const { service, eventBus } = await makeHarness();
    const seen: unknown[] = [];
    eventBus.on((e) => {
      if ((e as { type: string }).type === 'session_meta.changed') seen.push(e);
    });
    // Feed the service a "turn ended" signal through whatever derived entry
    // point the implementation settles on (bus event or explicit method).
    // We emit a bus event here so both wire paths remain valid.
    eventBus.emit({ type: 'turn.end' } as unknown as Parameters<
      typeof eventBus.emit
    >[0]);
    expect(seen).toHaveLength(0);
    // Sanity: wire-truth writes still emit.
    await service.setTitle('ok', 'user');
    expect(seen).toHaveLength(1);
  });

  it('get() returns a snapshot — mutations on it do not affect later reads', async () => {
    const { service } = await makeHarness();
    await service.setTitle('snapshot', 'user');
    const snap = service.get();
    (snap as { title?: string }).title = 'tamper';
    expect(service.get().title).toBe('snapshot');
  });
});

// ── state.json integration (sanity) ───────────────────────────────────

describe('SessionMetaService.flushPending (T1 sanity)', () => {
  it('a successful setTitle eventually lands the title in state.json via flushPending', async () => {
    const { service, statePath } = await makeHarness();
    await service.setTitle('persisted', 'user');
    await service.flushPending();
    const raw = await readFile(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as { custom_title?: string };
    expect(parsed.custom_title).toBe('persisted');
  });
});
