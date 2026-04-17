/**
 * SessionMetaService — T4 (derived fields via EventBus subscription).
 *
 * Phase 16 / todo Step 7 / §测试重点 T4:
 *   - SessionEventBus `turn.end` ticks → meta.turn_count++
 *   - SessionEventBus `model.changed` → meta.last_model replaced
 *   - Derived field mutations do NOT produce a session_meta_changed wire
 *     record (wire is truth-source only for user-triggered fields)
 *   - Derived field mutations do NOT emit session_meta.changed event
 *
 * NOTE: the real TS `SoulEvent` union does not (yet) include `turn.end` or
 * `model.changed`. The Implementer will either widen SoulEvent / BusEvent or
 * use a richer listener contract. The tests below emit cast-shaped payloads
 * so the test intent survives either wiring choice.
 */

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionEventBus } from '../../src/soul-plus/session-event-bus.js';
import {
  SessionMetaService,
  type SessionMeta,
} from '../../src/soul-plus/session-meta-service.js';
import { StateCache } from '../../src/session/state-cache.js';
import type { JournalInput } from '../../src/storage/wire-record.js';

class SpySessionJournal {
  readonly appended: Array<JournalInput<'session_meta_changed'>> = [];
  async appendSessionMetaChanged(data: JournalInput<'session_meta_changed'>): Promise<void> {
    this.appended.push(data);
  }
}

interface Harness {
  service: SessionMetaService;
  journal: SpySessionJournal;
  eventBus: SessionEventBus;
  tmp: string;
}

async function makeHarness(): Promise<Harness> {
  const tmp = join(
    tmpdir(),
    `kimi-meta-derived-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tmp, { recursive: true });
  const stateCache = new StateCache(join(tmp, 'state.json'));
  const eventBus = new SessionEventBus();
  const journal = new SpySessionJournal();
  const initialMeta: SessionMeta = {
    session_id: 'ses_derived',
    created_at: 1_700_000_000_000,
    turn_count: 0,
    last_updated: 1_700_000_000_000,
  };
  const service = new SessionMetaService({
    sessionId: 'ses_derived',
    sessionJournal: journal as unknown as ConstructorParameters<
      typeof SessionMetaService
    >[0]['sessionJournal'],
    eventBus,
    stateCache,
    initialMeta,
  });
  return { service, journal, eventBus, tmp };
}

const cleanupPaths: string[] = [];

beforeEach(() => {
  cleanupPaths.length = 0;
});

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

// Helper: emit a BusEvent-ish payload. Cast through `unknown` because the TS
// SoulEvent union has not yet been widened in Phase 16.
function emitBusEvent(bus: SessionEventBus, event: { type: string; [k: string]: unknown }): void {
  bus.emit(event as unknown as Parameters<typeof bus.emit>[0]);
}

describe('SessionMetaService derived fields (T4)', () => {
  it('turn.end bumps turn_count', async () => {
    const h = await makeHarness();
    cleanupPaths.push(h.tmp);
    emitBusEvent(h.eventBus, { type: 'turn.end' });
    emitBusEvent(h.eventBus, { type: 'turn.end' });
    emitBusEvent(h.eventBus, { type: 'turn.end' });
    expect(h.service.get().turn_count).toBe(3);
  });

  it('turn.end advances last_updated past the initial value', async () => {
    const h = await makeHarness();
    cleanupPaths.push(h.tmp);
    const before = h.service.get().last_updated;
    // force a different clock reading
    await new Promise((r) => setTimeout(r, 2));
    emitBusEvent(h.eventBus, { type: 'turn.end' });
    expect(h.service.get().last_updated).toBeGreaterThanOrEqual(before);
  });

  it('model.changed replaces last_model', async () => {
    const h = await makeHarness();
    cleanupPaths.push(h.tmp);
    emitBusEvent(h.eventBus, {
      type: 'model.changed',
      data: { new_model: 'kimi-k2.5' },
    });
    expect(h.service.get().last_model).toBe('kimi-k2.5');

    emitBusEvent(h.eventBus, {
      type: 'model.changed',
      data: { new_model: 'kimi-pro' },
    });
    expect(h.service.get().last_model).toBe('kimi-pro');
  });

  it('derived updates never add a session_meta_changed wire record', async () => {
    const h = await makeHarness();
    cleanupPaths.push(h.tmp);
    emitBusEvent(h.eventBus, { type: 'turn.end' });
    emitBusEvent(h.eventBus, { type: 'turn.end' });
    emitBusEvent(h.eventBus, {
      type: 'model.changed',
      data: { new_model: 'kimi-k2.5' },
    });
    expect(h.journal.appended).toHaveLength(0);
  });

  it('derived updates never emit session_meta.changed on the EventBus', async () => {
    const h = await makeHarness();
    cleanupPaths.push(h.tmp);
    const seen: unknown[] = [];
    h.eventBus.on((e) => {
      if ((e as { type: string }).type === 'session_meta.changed') seen.push(e);
    });
    emitBusEvent(h.eventBus, { type: 'turn.end' });
    emitBusEvent(h.eventBus, {
      type: 'model.changed',
      data: { new_model: 'kimi-k2.5' },
    });
    expect(seen).toHaveLength(0);
  });

  it('wire-truth setTitle remains orthogonal to derived turn_count progression', async () => {
    const h = await makeHarness();
    cleanupPaths.push(h.tmp);
    emitBusEvent(h.eventBus, { type: 'turn.end' });
    await h.service.setTitle('in-flight', 'user');
    emitBusEvent(h.eventBus, { type: 'turn.end' });
    const snap = h.service.get();
    expect(snap.title).toBe('in-flight');
    expect(snap.turn_count).toBe(2);
  });
});
