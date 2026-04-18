/**
 * SessionMetaService — T4 real integration (Phase 16 review fix #①).
 *
 * The T4 unit suite emits `turn.end` / `model.changed` directly onto the
 * bus via a cast. That pins the listener contract but does NOT prove the
 * production emit paths exist — without emitters, derived fields remain
 * forever stuck in memory. This test drives the events through the
 * REAL emitters:
 *
 *   - `TurnManager.onTurnEnd` must call `sink.emit({type:'turn.end'})`
 *     after the turn settles (derived → turn_count++).
 *   - `WiredContextState.applyConfigChange({type:'model_changed',...})`
 *     must emit `{type:'model.changed', data:{new_model}}` on the same
 *     sink after the WAL write (derived → last_model).
 *
 * Both emits share the SessionEventBus the SessionMetaService subscribes
 * to. Regression on either emitter flips this test red.
 */

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SoulLifecycleGate,
  SessionEventBus,
  SessionLifecycleStateMachine,
  SoulRegistry,
  TurnManager,
  createRuntime,
} from '../../src/soul-plus/index.js';
import {
  SessionMetaService,
  type SessionMeta,
} from '../../src/soul-plus/session-meta-service.js';
import { StateCache } from '../../src/session/state-cache.js';
import { WiredContextState } from '../../src/storage/context-state.js';
import {
  NoopJournalWriter,
  type JournalWriter,
} from '../../src/storage/journal-writer.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import type { JournalInput } from '../../src/storage/wire-record.js';
import { makeEndTurnResponse } from '../soul/fixtures/common.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';
import {
  createNoopCompactionProvider,
  createNoopJournalCapability,
} from './fixtures/slice3-harness.js';
import { makeRealSubcomponents } from './fixtures/real-subcomponents.js';

class SpySessionJournal {
  readonly appended: Array<JournalInput<'session_meta_changed'>> = [];
  async appendSessionMetaChanged(
    data: JournalInput<'session_meta_changed'>,
  ): Promise<void> {
    this.appended.push(data);
  }
}

interface Harness {
  readonly service: SessionMetaService;
  readonly manager: TurnManager;
  readonly contextState: WiredContextState;
  readonly eventBus: SessionEventBus;
  readonly tmp: string;
}

const cleanupPaths: string[] = [];

function makeInitialMeta(): SessionMeta {
  return {
    session_id: 'ses_integ',
    created_at: 1_700_000_000_000,
    turn_count: 0,
    last_updated: 1_700_000_000_000,
    last_model: 'kimi-bootstrap',
  };
}

async function buildHarness(
  kosong: ScriptedKosongAdapter,
): Promise<Harness> {
  const tmp = join(
    tmpdir(),
    `kimi-meta-integ-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tmp, { recursive: true });
  cleanupPaths.push(tmp);

  const stateMachine = new SessionLifecycleStateMachine();
  const gate = new SoulLifecycleGate(stateMachine);
  const eventBus = new SessionEventBus();
  const stateCache = new StateCache(join(tmp, 'state.json'));
  const journalWriter: JournalWriter = new NoopJournalWriter();
  const contextState = new WiredContextState({
    journalWriter,
    initialModel: 'kimi-bootstrap',
    currentTurnId: () => 'turn_live',
    sink: eventBus,
  });
  const sessionJournal = new InMemorySessionJournalImpl();
  const runtime = createRuntime({
    kosong,
    lifecycle: gate,
    compactionProvider: createNoopCompactionProvider(),
    journal: createNoopJournalCapability(),
  });
  const soulRegistry = new SoulRegistry({
    createHandle: (key, agentDepth) => ({
      key,
      agentId: 'agent_main',
      abortController: new AbortController(),
      agentDepth,
    }),
  });
  const subcomponents = makeRealSubcomponents({
    contextState,
    lifecycleStateMachine: stateMachine,
    sink: eventBus,
  });
  const manager = new TurnManager({
    contextState,
    sessionJournal,
    runtime,
    sink: eventBus,
    lifecycleStateMachine: stateMachine,
    soulRegistry,
    tools: [],
    compaction: subcomponents.compaction,
    permissionBuilder: subcomponents.permissionBuilder,
    lifecycle: subcomponents.lifecycle,
    wakeScheduler: subcomponents.wakeScheduler,
  });

  const spyJournal = new SpySessionJournal();
  const service = new SessionMetaService({
    sessionId: 'ses_integ',
    sessionJournal: spyJournal as unknown as ConstructorParameters<
      typeof SessionMetaService
    >[0]['sessionJournal'],
    eventBus,
    stateCache,
    initialMeta: makeInitialMeta(),
  });

  return { service, manager, contextState, eventBus, tmp };
}

beforeEach(() => {
  cleanupPaths.length = 0;
});

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

describe('SessionMetaService + real emitters (Phase 16 T4 integration)', () => {
  it('TurnManager.onTurnEnd increments SessionMetaService.turn_count', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done')],
    });
    const h = await buildHarness(kosong);

    expect(h.service.get().turn_count).toBe(0);

    const response = await h.manager.handlePrompt({
      data: { input: { text: 'hi' } },
    });
    if (!('turn_id' in response)) throw new Error('expected turn_id');
    await h.manager.awaitTurn(response.turn_id);

    // The real TurnManager.onTurnEnd should have emitted `turn.end` on
    // the shared SessionEventBus. SessionMetaService's subscription
    // bumps turn_count.
    expect(h.service.get().turn_count).toBe(1);
  });

  it('two back-to-back turns tick turn_count twice', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeEndTurnResponse('first'),
        makeEndTurnResponse('second'),
      ],
    });
    const h = await buildHarness(kosong);

    const r1 = await h.manager.handlePrompt({ data: { input: { text: 'hi' } } });
    if (!('turn_id' in r1)) throw new Error('expected turn_id');
    await h.manager.awaitTurn(r1.turn_id);

    const r2 = await h.manager.handlePrompt({ data: { input: { text: 'again' } } });
    if (!('turn_id' in r2)) throw new Error('expected turn_id');
    await h.manager.awaitTurn(r2.turn_id);

    expect(h.service.get().turn_count).toBe(2);
  });

  it('ContextState.applyConfigChange({model_changed,...}) updates SessionMetaService.last_model', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('filler')],
    });
    const h = await buildHarness(kosong);

    expect(h.service.get().last_model).toBe('kimi-bootstrap');

    await h.contextState.applyConfigChange({
      type: 'model_changed',
      old_model: 'kimi-bootstrap',
      new_model: 'kimi-k2.5',
    });

    expect(h.service.get().last_model).toBe('kimi-k2.5');
  });

  it('derived fields do NOT append a wire `session_meta_changed` record', async () => {
    // Regression guard: the real TurnManager / ContextState emits must
    // never flow into the wire through SessionMetaService (wire is for
    // user-triggered fields only — §6.13.7 D6). We introspect the spy
    // SessionJournal used for SessionMetaService's own writes.
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done')],
    });
    const h = await buildHarness(kosong);
    const spyJournal = (
      h.service as unknown as { deps: { sessionJournal: SpySessionJournal } }
    ).deps.sessionJournal;

    const response = await h.manager.handlePrompt({
      data: { input: { text: 'go' } },
    });
    if (!('turn_id' in response)) throw new Error('expected turn_id');
    await h.manager.awaitTurn(response.turn_id);
    await h.contextState.applyConfigChange({
      type: 'model_changed',
      old_model: 'kimi-bootstrap',
      new_model: 'kimi-v3',
    });

    expect(spyJournal.appended).toHaveLength(0);
  });
});
