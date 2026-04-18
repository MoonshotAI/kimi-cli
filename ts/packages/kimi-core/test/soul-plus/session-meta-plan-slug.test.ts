/**
 * SessionMeta.plan_slug — Phase 18 Section D.7 tests.
 *
 * Adds an optional `plan_slug?: string` wire-truth field to
 * SessionMeta so the hero-name slug chosen by `generatePlanSlug`
 * (D.1) survives process restart. Changes span:
 *
 *   1. `SessionMeta` interface — `plan_slug?: string`
 *   2. `SessionMetaService` — accepts `{ plan_slug }` in
 *       `applyPatch` / exposes `setPlanSlug(slug, source)`
 *   3. `PlanFileManager` — reads the slug from
 *       `SessionMetaService.get().plan_slug` rather than passing a
 *       `getSlug` closure, so a resumed session picks up the slug
 *       it was using before the crash.
 *
 * RED until D.7 lands.
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
import { PathConfig } from '../../src/session/path-config.js';
import type { JournalInput } from '../../src/storage/wire-record.js';

// Module added in Phase 18 D.2 / D.7 wiring.
import { PlanFileManager } from '../../src/storage/plan-file-manager.js';

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
  readonly stateCache: StateCache;
  readonly tmp: string;
}

async function buildHarness(opts: {
  initialMeta?: Partial<SessionMeta>;
  flushDebounceMs?: number;
} = {}): Promise<Harness> {
  const tmp = join(tmpdir(), `kimi-plan-slug-meta-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
  return { service, journal, stateCache, tmp };
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

// ── D.7 interface widening ────────────────────────────────────────────

describe('SessionMeta.plan_slug field', () => {
  it('SessionMeta accepts a plan_slug in initial meta', async () => {
    const { service } = await makeHarness({
      initialMeta: { plan_slug: 'iron-man-thor-hulk' },
    });
    expect(service.get().plan_slug).toBe('iron-man-thor-hulk');
  });

  it('SessionMetaService exposes setPlanSlug which writes a wire record', async () => {
    const { service, journal } = await makeHarness();
    // Phase 18 D.7 — new write method
    const setPlanSlug = (
      service as unknown as { setPlanSlug?: (slug: string, source: string) => Promise<void> }
    ).setPlanSlug;
    expect(typeof setPlanSlug).toBe('function');
    await setPlanSlug!('spider-man-groot-rocket', 'system');
    expect(service.get().plan_slug).toBe('spider-man-groot-rocket');
    expect(journal.appended).toHaveLength(1);
    const rec = journal.appended[0]!;
    // patch.plan_slug in wire shape (snake_case already)
    expect(
      (rec.patch as { plan_slug?: string } | undefined)?.plan_slug,
    ).toBe('spider-man-groot-rocket');
  });

  it('recoverFromReplay restores plan_slug from wire records', async () => {
    const { service } = await makeHarness();
    (service as unknown as { recoverFromReplay(p: Partial<SessionMeta>): void }).recoverFromReplay({
      plan_slug: 'thor-hulk-vision',
    });
    expect(service.get().plan_slug).toBe('thor-hulk-vision');
  });
});

// ── PlanFileManager integration (D.2 + D.7) ──────────────────────────

describe('PlanFileManager wired with SessionMetaService', () => {
  it('constructor reads plan_slug from SessionMetaService and uses it for the path', async () => {
    const { service, tmp } = await makeHarness({
      initialMeta: { plan_slug: 'vision-scarlet-witch-doctor-strange' },
    });
    const paths = new PathConfig({ home: tmp });
    type Ctor = new (deps: {
      paths: PathConfig;
      sessionId: string;
      sessionMeta: SessionMetaService;
    }) => { getCurrentPlanPath(): string };
    const mgr = new (PlanFileManager as unknown as Ctor)({
      paths,
      sessionId: 'ses_test',
      sessionMeta: service,
    });
    const p = mgr.getCurrentPlanPath();
    expect(p).toContain('vision-scarlet-witch-doctor-strange.md');
  });

  it('after restart (new service instance recovering from wire) PlanFileManager sees the same slug', async () => {
    // Turn 1: set the slug
    const { service: svc1, tmp } = await makeHarness();
    const setPlanSlug = (
      svc1 as unknown as { setPlanSlug?: (slug: string, source: string) => Promise<void> }
    ).setPlanSlug;
    await setPlanSlug!('hawkeye-falcon-wasp', 'system');

    // Turn 2: fresh service, recover from replay (simulates process restart)
    const h2 = await makeHarness();
    const svc2 = h2.service;
    (svc2 as unknown as { recoverFromReplay(p: Partial<SessionMeta>): void }).recoverFromReplay({
      plan_slug: 'hawkeye-falcon-wasp',
    });

    const paths = new PathConfig({ home: tmp });
    type Ctor = new (deps: {
      paths: PathConfig;
      sessionId: string;
      sessionMeta: SessionMetaService;
    }) => { getCurrentPlanPath(): string };
    const mgr = new (PlanFileManager as unknown as Ctor)({
      paths,
      sessionId: 'ses_test',
      sessionMeta: svc2,
    });
    expect(mgr.getCurrentPlanPath()).toContain('hawkeye-falcon-wasp.md');
  });
});
