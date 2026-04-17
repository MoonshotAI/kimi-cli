/**
 * Phase 17 A.1 — multi-session bridge isolation.
 *
 * Two concurrent sessions share the transport layer but each owns its
 * own WireEventBridge instance. Cross-session leakage is a regression
 * risk because the test-local helper used a single `currentTurnId` ref
 * (see note in `test/e2e/helpers/wire-event-bridge.ts:25`). The src
 * version must allocate per-session state so events fired on session A
 * NEVER land on session B's transport.
 */

import { describe, expect, it } from 'vitest';

import { installWireEventBridge } from '../../src/wire-protocol/event-bridge.js';
import { WireCodec } from '../../src/wire-protocol/codec.js';
import { SessionEventBus } from '../../src/soul-plus/session-event-bus.js';
import {
  TurnLifecycleTracker,
  type TurnLifecycleListener,
} from '../../src/soul-plus/turn-lifecycle-tracker.js';
import { createLinkedTransportPair } from '../../src/transport/memory-transport.js';
import type { WireMessage } from '../../src/wire-protocol/types.js';

async function makeSession(sessionId: string): Promise<{
  frames: WireMessage[];
  eventBus: SessionEventBus;
  tracker: TurnLifecycleTracker;
  dispose(): Promise<void>;
}> {
  const [client, server] = createLinkedTransportPair();
  const codec = new WireCodec();
  const frames: WireMessage[] = [];
  client.onMessage = (raw) => {
    try {
      frames.push(codec.decode(raw));
    } catch {
      /* ignore */
    }
  };
  await Promise.all([client.connect(), server.connect()]);
  const eventBus = new SessionEventBus();
  const tracker = new TurnLifecycleTracker();
  const bridge = installWireEventBridge({
    server,
    eventBus,
    addTurnLifecycleListener: (l: TurnLifecycleListener) => tracker.addListener(l),
    sessionId,
  });
  return {
    frames,
    eventBus,
    tracker,
    dispose: async () => {
      bridge.dispose();
      await client.close();
    },
  };
}

describe('Phase 17 A.1 — multi-session wire bridge isolation', () => {
  it('content.delta emitted on session A does not appear on session B transport', async () => {
    const a = await makeSession('ses_A');
    const b = await makeSession('ses_B');
    try {
      a.tracker.fireLifecycleEvent({
        kind: 'begin',
        turnId: 'turn_a1',
        userInput: 'A',
        inputKind: 'user',
        agentType: 'main',
      });
      b.tracker.fireLifecycleEvent({
        kind: 'begin',
        turnId: 'turn_b1',
        userInput: 'B',
        inputKind: 'user',
        agentType: 'main',
      });
      await Promise.resolve();

      a.eventBus.emit({ type: 'content.delta', delta: 'A-only' });
      await Promise.resolve();

      const aDeltas = a.frames.filter((f) => f.method === 'content.delta');
      const bDeltas = b.frames.filter((f) => f.method === 'content.delta');
      expect(aDeltas).toHaveLength(1);
      expect(bDeltas).toHaveLength(0);
      expect(aDeltas[0]!.turn_id).toBe('turn_a1');
      expect(aDeltas[0]!.session_id).toBe('ses_A');
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });

  it('interleaved turn lifecycles: each session tags its own turn_id on step.begin', async () => {
    const a = await makeSession('ses_A');
    const b = await makeSession('ses_B');
    try {
      a.tracker.fireLifecycleEvent({
        kind: 'begin',
        turnId: 'turn_a1',
        userInput: 'a',
        inputKind: 'user',
        agentType: 'main',
      });
      b.tracker.fireLifecycleEvent({
        kind: 'begin',
        turnId: 'turn_b1',
        userInput: 'b',
        inputKind: 'user',
        agentType: 'main',
      });
      await Promise.resolve();

      // Interleave step events on both sessions.
      a.eventBus.emit({ type: 'step.begin', step: 1 });
      b.eventBus.emit({ type: 'step.begin', step: 1 });
      a.eventBus.emit({ type: 'step.begin', step: 2 });
      await Promise.resolve();

      const aSteps = a.frames.filter((f) => f.method === 'step.begin');
      const bSteps = b.frames.filter((f) => f.method === 'step.begin');

      expect(aSteps).toHaveLength(2);
      expect(bSteps).toHaveLength(1);
      for (const s of aSteps) expect(s.turn_id).toBe('turn_a1');
      for (const s of bSteps) expect(s.turn_id).toBe('turn_b1');
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });
});
