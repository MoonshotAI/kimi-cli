/**
 * Covers: `createRuntime` (v2 §5.1.5 / §5.8.2 post Phase 2).
 *
 * Phase 2 (todo/phase-2-compaction-out-of-soul.md): `Runtime` collapsed
 * to a single required field — `kosong`. The factory must return an
 * object with exactly that field populated with the caller-supplied
 * adapter. Compaction / lifecycle / journal capabilities no longer flow
 * through Runtime; they live on `SoulPlusDeps` / `TurnManagerDeps`
 * instead.
 */

import { describe, expect, it } from 'vitest';

import { createRuntime } from '../../src/soul-plus/index.js';
import type { Runtime } from '../../src/soul/index.js';
import { makeEndTurnResponse } from '../soul/fixtures/common.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';

describe('createRuntime — Phase 2 single-field Runtime', () => {
  it('returns a Runtime whose sole required field is `kosong`', () => {
    const kosong = new ScriptedKosongAdapter({ responses: [makeEndTurnResponse('ok')] });

    const runtime: Runtime = createRuntime({ kosong });

    expect(runtime.kosong).toBe(kosong);
    expect(Object.keys(runtime)).toEqual(['kosong']);
  });

  it('does not expose the legacy compactionProvider / lifecycle / journal fields', () => {
    const runtime = createRuntime({
      kosong: new ScriptedKosongAdapter({ responses: [] }),
    });

    expect(runtime).not.toHaveProperty('compactionProvider');
    expect(runtime).not.toHaveProperty('lifecycle');
    expect(runtime).not.toHaveProperty('journal');
    expect(runtime).not.toHaveProperty('tools');
    expect(runtime).not.toHaveProperty('subagentHost');
    expect(runtime).not.toHaveProperty('clock');
    expect(runtime).not.toHaveProperty('logger');
  });

  it('does not copy or clone the kosong adapter', () => {
    // Runtime must hand out a reference, not a wrapper — otherwise a
    // stateful adapter would desync from the reference the test keeps
    // asserting against.
    const kosong = new ScriptedKosongAdapter({ responses: [makeEndTurnResponse('hi')] });
    const runtime = createRuntime({ kosong });
    expect(runtime.kosong).toBe(kosong);
  });

  it('silently ignores legacy compactionProvider / lifecycle / journal when passed via RuntimeFactoryDeps', () => {
    // Phase 2 compat shim: `RuntimeFactoryDeps` still accepts the old
    // three fields as optional so the 20+ existing `createRuntime({
    // kosong, compactionProvider, lifecycle, journal })` call sites
    // (tests + apps/kimi-cli/src/index.ts) keep compiling. The factory
    // must drop them from the returned `Runtime` value — Soul no
    // longer reads any of them.
    const kosong = new ScriptedKosongAdapter({ responses: [] });
    const runtime = createRuntime({
      kosong,
      compactionProvider: {
        async run() {
          throw new Error('legacy compactionProvider should not leak onto Runtime');
        },
      },
      lifecycle: {
        async transitionTo() {
          throw new Error('legacy lifecycle should not leak onto Runtime');
        },
      },
      journal: {
        async rotate() {
          return { archiveFile: 'ignored.jsonl' };
        },
      },
    });

    expect(Object.keys(runtime)).toEqual(['kosong']);
    expect(runtime.kosong).toBe(kosong);
    expect(runtime).not.toHaveProperty('compactionProvider');
    expect(runtime).not.toHaveProperty('lifecycle');
    expect(runtime).not.toHaveProperty('journal');
  });
});
