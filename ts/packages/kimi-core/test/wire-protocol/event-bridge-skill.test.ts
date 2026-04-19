/**
 * Phase 24 T2 — event-bridge forwards skill.invoked / skill.completed → WireEvent.
 *
 * Decision §3.2 (Phase 24): EventBus emits skill.invoked → event-bridge translates
 * to wire event with method='skill.invoked' and forwards to transport.
 *
 * ALL tests are skipped because they require:
 *   1. New SoulEvent variants `skill.invoked` / `skill.completed` in event-sink.ts
 *   2. New WireEventMethod literals `'skill.invoked'` / `'skill.completed'` in types.ts
 *   3. New case blocks in event-bridge.ts soulListener switch
 *
 * Phase 24 Step 3: Implementer must unskip after adding the SoulEvent variants
 * and event-bridge cases.
 */

import { describe, expect, it } from 'vitest';

import { WireCodec } from '../../src/wire-protocol/codec.js';
import { installWireEventBridge } from '../../src/wire-protocol/event-bridge.js';
import { SessionEventBus } from '../../src/soul-plus/session-event-bus.js';
import { TurnLifecycleTracker } from '../../src/soul-plus/turn-lifecycle-tracker.js';
import {
  createLinkedTransportPair,
  type MemoryTransport,
} from '../../src/transport/memory-transport.js';
import type { WireMessage } from '../../src/wire-protocol/types.js';
import type { SoulEvent } from '../../src/soul/event-sink.js';

async function makeHarness(sessionId = 'ses_test') {
  const [client, server] = createLinkedTransportPair();
  const codec = new WireCodec();
  const frames: WireMessage[] = [];
  client.onMessage = (frame) => {
    try {
      frames.push(codec.decode(frame));
    } catch {
      /* ignore malformed frames */
    }
  };
  await Promise.all([client.connect(), server.connect()]);

  const eventBus = new SessionEventBus();
  const tracker = new TurnLifecycleTracker();

  const bridge = installWireEventBridge({
    server,
    eventBus,
    addTurnLifecycleListener: (l) => tracker.addListener(l),
    sessionId,
  });

  return {
    eventBus,
    frames,
    dispose: async () => {
      bridge.dispose();
      await client.close();
      await server.close();
    },
  };
}

// Phase 24 Step 3: Implementer must add SoulEvent variants + event-bridge cases and unskip
describe('event-bridge — skill.invoked / skill.completed forwarding (Phase 24 T2)', () => {
  it('skill.invoked SoulEvent → wire event method=skill.invoked with correct data', async () => {
    const { eventBus, frames, dispose } = await makeHarness();

    // Phase 24: new SoulEvent type — cast needed until event-sink.ts is updated
    const skillInvokedEvent = {
      type: 'skill.invoked',
      data: {
        skill_name: 'commit',
        execution_mode: 'inline',
        original_input: 'commit my work',
        invocation_trigger: 'user-slash',
        query_depth: 0,
      },
    } as unknown as SoulEvent;

    eventBus.emit(skillInvokedEvent);

    await new Promise((resolve) => setImmediate(resolve));

    const wireEvents = frames.filter((f) => f.type === 'event');
    const skillWire = wireEvents.find((f) => f.method === 'skill.invoked');
    expect(skillWire).toBeDefined();

    const data = skillWire!.data as Record<string, unknown>;
    expect(data['skill_name']).toBe('commit');
    expect(data['execution_mode']).toBe('inline');
    expect(data['invocation_trigger']).toBe('user-slash');
    expect(data['query_depth']).toBe(0);

    await dispose();
  });

  it('skill.completed SoulEvent → wire event method=skill.completed', async () => {
    const { eventBus, frames, dispose } = await makeHarness();

    const skillCompletedEvent = {
      type: 'skill.completed',
      data: {
        skill_name: 'commit',
        execution_mode: 'inline',
        success: true,
        invocation_trigger: 'user-slash',
        query_depth: 0,
      },
    } as unknown as SoulEvent;

    eventBus.emit(skillCompletedEvent);
    await new Promise((resolve) => setImmediate(resolve));

    const skillWire = frames.find((f) => f.type === 'event' && f.method === 'skill.completed');
    expect(skillWire).toBeDefined();
    const data = skillWire!.data as Record<string, unknown>;
    expect(data['skill_name']).toBe('commit');
    expect(data['success']).toBe(true);

    await dispose();
  });

  it('skill events carry monotonically increasing seq (bridge-managed counter)', async () => {
    const { eventBus, frames, dispose } = await makeHarness();

    for (let i = 0; i < 3; i++) {
      eventBus.emit({
        type: 'skill.invoked',
        data: { skill_name: `skill_${String(i)}`, execution_mode: 'inline', original_input: '' },
      } as unknown as SoulEvent);
    }
    await new Promise((resolve) => setImmediate(resolve));

    const seqs = frames
      .filter((f) => f.type === 'event' && f.method === 'skill.invoked')
      .map((f) => f.seq!);
    expect(seqs).toHaveLength(3);
    // Monotonically increasing
    expect(seqs[1]!).toBeGreaterThan(seqs[0]!);
    expect(seqs[2]!).toBeGreaterThan(seqs[1]!);

    await dispose();
  });
});
