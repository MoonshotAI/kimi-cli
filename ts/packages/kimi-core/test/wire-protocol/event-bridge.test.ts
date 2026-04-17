/**
 * Phase 17 A.1 — event-bridge SoulEvent → WireEvent translation.
 *
 * The production `installWireEventBridge` is moving from
 * `test/e2e/helpers/wire-event-bridge.ts` into
 * `src/wire-protocol/event-bridge.ts`. These unit tests pin the
 * translation table: given a `SoulEvent` (or `TurnLifecycleEvent`) on
 * the input bus, the correct `WireEvent` must be pushed onto the
 * transport.
 *
 * Scope (Phase 17 §Section A.1):
 *   - 6 translation cases: turn.begin / step.begin / content.delta /
 *     turn.end / tool.call / tool.result
 *   - No approval / reverse-RPC scope here (see A.3 + B.7 for those).
 *   - No multi-session concurrency here (see
 *     `wire-event-bridge-multi-session.test.ts`).
 *
 * Expected state before implementer: these imports fail because the
 * `src/wire-protocol/event-bridge.ts` module does not yet exist. The
 * shape of the API is pinned to the existing test helper so the lift is
 * mechanical:
 *   - `installWireEventBridge(opts: InstallWireEventBridgeOptions):
 *      WireEventBridgeHandle`
 */

import { describe, expect, it } from 'vitest';

import { WireCodec } from '../../src/wire-protocol/codec.js';
import {
  installWireEventBridge,
  type WireEventBridgeHandle,
} from '../../src/wire-protocol/event-bridge.js';
import { SessionEventBus } from '../../src/soul-plus/session-event-bus.js';
import {
  TurnLifecycleTracker,
  type TurnLifecycleListener,
} from '../../src/soul-plus/turn-lifecycle-tracker.js';
import {
  createLinkedTransportPair,
  type MemoryTransport,
} from '../../src/transport/memory-transport.js';
import type { WireMessage } from '../../src/wire-protocol/types.js';

interface Harness {
  readonly server: MemoryTransport;
  readonly clientFrames: WireMessage[];
  readonly eventBus: SessionEventBus;
  readonly tracker: TurnLifecycleTracker;
  readonly bridge: WireEventBridgeHandle;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

async function makeHarness(sessionId = 'ses_test'): Promise<Harness> {
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
    addTurnLifecycleListener: (l: TurnLifecycleListener) =>
      tracker.addListener(l),
    sessionId,
  });

  const dispose = async (): Promise<void> => {
    bridge.dispose();
    await client.close();
  };

  return {
    server,
    clientFrames: frames,
    eventBus,
    tracker,
    bridge,
    dispose,
    [Symbol.asyncDispose]: dispose,
  };
}

function eventsOf(frames: readonly WireMessage[], method: string): WireMessage[] {
  return frames.filter((f) => f.type === 'event' && f.method === method);
}

describe('Phase 17 A.1 — event-bridge SoulEvent → WireEvent translation', () => {
  it('turn.begin: TurnLifecycleEvent.begin → wire turn.begin with user_input + input_kind + turn_id', async () => {
    await using harness = await makeHarness('ses_a1_begin');
    harness.tracker.fireLifecycleEvent({
      kind: 'begin',
      turnId: 'turn_1',
      userInput: 'hello',
      inputKind: 'user',
      agentType: 'main',
    });

    // Allow the bridge to fan-out (synchronous emits that still settle
    // via the listener loop).
    await Promise.resolve();

    const begins = eventsOf(harness.clientFrames, 'turn.begin');
    expect(begins).toHaveLength(1);
    expect(begins[0]!.turn_id).toBe('turn_1');
    expect(begins[0]!.session_id).toBe('ses_a1_begin');
    const data = begins[0]!.data as { turn_id: string; user_input: string; input_kind: string };
    expect(data.turn_id).toBe('turn_1');
    expect(data.user_input).toBe('hello');
    expect(data.input_kind).toBe('user');
  });

  it('step.begin: SoulEvent step.begin → wire step.begin with step + current turn_id', async () => {
    await using harness = await makeHarness('ses_a1_step');
    harness.tracker.fireLifecycleEvent({
      kind: 'begin',
      turnId: 'turn_1',
      userInput: 'hi',
      inputKind: 'user',
      agentType: 'main',
    });
    await Promise.resolve();
    harness.eventBus.emit({ type: 'step.begin', step: 1 });
    await Promise.resolve();

    const steps = eventsOf(harness.clientFrames, 'step.begin');
    expect(steps).toHaveLength(1);
    expect(steps[0]!.turn_id).toBe('turn_1');
    expect((steps[0]!.data as { step: number }).step).toBe(1);
  });

  it('content.delta: SoulEvent content.delta → wire content.delta{type:text, text}', async () => {
    await using harness = await makeHarness('ses_a1_delta');
    harness.tracker.fireLifecycleEvent({
      kind: 'begin',
      turnId: 'turn_1',
      userInput: 'hi',
      inputKind: 'user',
      agentType: 'main',
    });
    await Promise.resolve();
    harness.eventBus.emit({ type: 'content.delta', delta: 'hello ' });
    harness.eventBus.emit({ type: 'content.delta', delta: 'world' });
    await Promise.resolve();

    const deltas = eventsOf(harness.clientFrames, 'content.delta');
    expect(deltas).toHaveLength(2);
    const texts = deltas.map((d) => (d.data as { type: string; text?: string }).text);
    expect(texts.join('')).toBe('hello world');
    for (const d of deltas) {
      expect((d.data as { type: string }).type).toBe('text');
      expect(d.turn_id).toBe('turn_1');
    }
  });

  it('tool.call: SoulEvent tool.call → wire tool.call with id/name/args', async () => {
    await using harness = await makeHarness('ses_a1_tool');
    harness.tracker.fireLifecycleEvent({
      kind: 'begin',
      turnId: 'turn_1',
      userInput: 'x',
      inputKind: 'user',
      agentType: 'main',
    });
    await Promise.resolve();
    harness.eventBus.emit({
      type: 'tool.call',
      toolCallId: 'tc_1',
      name: 'Bash',
      args: { command: 'ls' },
    });
    await Promise.resolve();

    const calls = eventsOf(harness.clientFrames, 'tool.call');
    expect(calls).toHaveLength(1);
    const data = calls[0]!.data as { id: string; name: string; args: Record<string, unknown> };
    expect(data.id).toBe('tc_1');
    expect(data.name).toBe('Bash');
    expect(data.args).toEqual({ command: 'ls' });
  });

  it('tool.result: SoulEvent tool.result → wire tool.result{tool_call_id, output, is_error?}', async () => {
    await using harness = await makeHarness('ses_a1_result');
    harness.tracker.fireLifecycleEvent({
      kind: 'begin',
      turnId: 'turn_1',
      userInput: 'x',
      inputKind: 'user',
      agentType: 'main',
    });
    await Promise.resolve();
    harness.eventBus.emit({
      type: 'tool.result',
      toolCallId: 'tc_1',
      output: 'ok',
      isError: false,
    });
    await Promise.resolve();

    const results = eventsOf(harness.clientFrames, 'tool.result');
    expect(results).toHaveLength(1);
    const data = results[0]!.data as {
      tool_call_id: string;
      output: string;
      is_error?: boolean;
    };
    expect(data.tool_call_id).toBe('tc_1');
    expect(data.output).toBe('ok');
    expect(data.is_error).toBe(false);
  });

  it('turn.end: TurnLifecycleEvent.end → wire turn.end with reason/success/usage', async () => {
    await using harness = await makeHarness('ses_a1_end');
    harness.tracker.fireLifecycleEvent({
      kind: 'begin',
      turnId: 'turn_1',
      userInput: 'hi',
      inputKind: 'user',
      agentType: 'main',
    });
    await Promise.resolve();
    harness.tracker.fireLifecycleEvent({
      kind: 'end',
      turnId: 'turn_1',
      reason: 'done',
      success: true,
      agentType: 'main',
      usage: { input: 10, output: 20 },
    });
    await Promise.resolve();

    const ends = eventsOf(harness.clientFrames, 'turn.end');
    expect(ends).toHaveLength(1);
    const data = ends[0]!.data as {
      turn_id: string;
      reason: string;
      success: boolean;
      usage?: { input_tokens: number; output_tokens: number };
    };
    expect(data.turn_id).toBe('turn_1');
    expect(data.reason).toBe('done');
    expect(data.success).toBe(true);
    expect(data.usage?.input_tokens).toBe(10);
    expect(data.usage?.output_tokens).toBe(20);
  });
});
