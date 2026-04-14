/**
 * Covers: `createRuntime` (v2 §5.1.5 / §5.8.2).
 *
 * The Runtime interface is a rigid 4-field bag — the factory must return
 * an object with exactly those fields, every one of them populated with
 * the exact dependency the caller passed in. This guards 铁律 6: Runtime
 * must not silently grow fifth-field injection (tools / SubagentHost /
 * clock / logger / idGenerator are all intentionally absent).
 */

import { describe, expect, it } from 'vitest';

import { createRuntime } from '../../src/soul-plus/index.js';
import type { Runtime } from '../../src/soul/index.js';
import { makeEndTurnResponse } from '../soul/fixtures/common.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';
import {
  createNoopCompactionProvider,
  createNoopJournalCapability,
  createSpyLifecycleGate,
} from './fixtures/slice3-harness.js';

describe('createRuntime', () => {
  it('returns a Runtime with exactly the four canonical fields', () => {
    const kosong = new ScriptedKosongAdapter({ responses: [makeEndTurnResponse('ok')] });
    const lifecycle = createSpyLifecycleGate();
    const compactionProvider = createNoopCompactionProvider();
    const journal = createNoopJournalCapability();

    const runtime: Runtime = createRuntime({
      kosong,
      compactionProvider,
      lifecycle,
      journal,
    });

    expect(runtime.kosong).toBe(kosong);
    expect(runtime.compactionProvider).toBe(compactionProvider);
    expect(runtime.lifecycle).toBe(lifecycle);
    expect(runtime.journal).toBe(journal);
    expect(Object.keys(runtime).toSorted()).toEqual(
      ['compactionProvider', 'journal', 'kosong', 'lifecycle'].toSorted(),
    );
  });

  it('does not expose extra fields beyond the four Runtime slots', () => {
    const runtime = createRuntime({
      kosong: new ScriptedKosongAdapter({ responses: [] }),
      lifecycle: createSpyLifecycleGate(),
      compactionProvider: createNoopCompactionProvider(),
      journal: createNoopJournalCapability(),
    });
    expect(Object.keys(runtime)).toHaveLength(4);
    expect(runtime).not.toHaveProperty('tools');
    expect(runtime).not.toHaveProperty('subagentHost');
    expect(runtime).not.toHaveProperty('clock');
    expect(runtime).not.toHaveProperty('logger');
  });

  it('does not copy or clone the passed-in dependencies', () => {
    // Runtime must hand out references, not wrappers — otherwise
    // `Runtime.kosong` in a stateful test would desync from the
    // adapter the test keeps asserting on.
    const kosong = new ScriptedKosongAdapter({ responses: [makeEndTurnResponse('hi')] });
    const runtime = createRuntime({
      kosong,
      lifecycle: createSpyLifecycleGate(),
      compactionProvider: createNoopCompactionProvider(),
      journal: createNoopJournalCapability(),
    });
    expect(runtime.kosong).toBe(kosong);
  });
});
