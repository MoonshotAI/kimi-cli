/**
 * Self-test — subprocess wire harness (Phase 9 §4).
 *
 * Skip-if-no-bin: the CLI `--wire` runner is stubbed until Phase 11
 * (see apps/kimi-cli/src/index.ts:runWire). `canStartWireSubprocess()`
 * returns `false` today, so the body executes only when a real bin is
 * wired up in the future.
 */

import { describe, expect, it } from 'vitest';

import {
  canStartWireSubprocess,
  createTempEnv,
} from '../helpers/index.js';

describe.skipIf(!canStartWireSubprocess())('startWireSubprocess', () => {
  it('boots and shuts down cleanly', async () => {
    const env = await createTempEnv();
    try {
      // Lazy import so the stub test at the top still works when the
      // binary isn't built.
      const { startWireSubprocess } = await import(
        '../helpers/wire/wire-subprocess-harness.js'
      );
      const harness = await startWireSubprocess({
        workDir: env.workDir.path,
        homeDir: env.homeDir.path,
      });
      try {
        // Placeholder — future Phase 11 tests will exercise initialize
        // + session.create + session.prompt end-to-end. Today just
        // verify pid comes back and dispose works.
        expect(harness.pid).toBeGreaterThan(0);
      } finally {
        await harness.dispose();
      }
    } finally {
      await env.cleanup();
    }
  });
});

describe('canStartWireSubprocess', () => {
  it('returns false today (Phase 9)', () => {
    expect(canStartWireSubprocess()).toBe(false);
  });
});
