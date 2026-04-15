import { describe, it, expect } from 'vitest';
import type { WireMessage } from '../src/types.js';
import { createEvent, _resetIdCounter } from '../src/types.js';
import { MockEventGenerator, evt, delay } from '../src/mock-event-generator.js';
import type { Scenario } from '../src/mock-event-generator.js';
import { simpleChatScenario } from '../src/scenarios/simple-chat.js';
import { toolCallScenario } from '../src/scenarios/tool-call.js';
import { thinkingScenario } from '../src/scenarios/thinking.js';
import { btwScenario } from '../src/scenarios/btw.js';
import { approvalScenarioFlat } from '../src/scenarios/approval.js';

// ── Helpers ───────────────────────────────────────────────────────────

async function collect(source: AsyncIterable<WireMessage>): Promise<WireMessage[]> {
  const items: WireMessage[] = [];
  for await (const item of source) {
    items.push(item);
  }
  return items;
}

// ── MockEventGenerator ────────────────────────────────────────────────

describe('MockEventGenerator', () => {
  it('generates events from a simple scenario', async () => {
    _resetIdCounter();
    const gen = new MockEventGenerator({ delayMultiplier: 0 });
    const opts = { session_id: 'test', turn_id: 'turn_1' };
    const scenario: Scenario = {
      name: 'test',
      description: 'test scenario',
      steps: [
        evt(createEvent('turn.begin', { turn_id: 'turn_1', user_input: 'hello', input_kind: 'user' }, opts)),
        evt(createEvent('step.begin', { step: 1 }, opts)),
        evt(createEvent('content.delta', { type: 'text', text: 'Hi!' }, opts)),
        evt(createEvent('turn.end', { turn_id: 'turn_1', reason: 'done', success: true }, opts)),
      ],
    };

    const events = await collect(gen.generate(scenario, 'test', 'turn_1'));

    expect(events).toHaveLength(4);
    expect(events[0]!.method).toBe('turn.begin');
    expect(events[1]!.method).toBe('step.begin');
    expect(events[2]!.method).toBe('content.delta');
    expect(events[3]!.method).toBe('turn.end');
  });

  it('handles delays with zero multiplier (instant)', async () => {
    _resetIdCounter();
    const gen = new MockEventGenerator({ delayMultiplier: 0 });
    const opts = { session_id: 'test', turn_id: 'turn_1' };
    const scenario: Scenario = {
      name: 'delayed',
      description: 'scenario with delays',
      steps: [
        evt(createEvent('turn.begin', { turn_id: 'turn_1', user_input: 'test', input_kind: 'user' }, opts)),
        delay(1000), // Would be 1 second, but multiplier is 0
        evt(createEvent('turn.end', { turn_id: 'turn_1', reason: 'done', success: true }, opts)),
      ],
    };

    const start = Date.now();
    const events = await collect(gen.generate(scenario, 'test', 'turn_1'));
    const elapsed = Date.now() - start;

    expect(events).toHaveLength(2);
    expect(elapsed).toBeLessThan(100); // Should be nearly instant
  });

  it('emits step.interrupted + turn.end when cancelled', async () => {
    _resetIdCounter();
    const gen = new MockEventGenerator({ delayMultiplier: 0 });
    const opts = { session_id: 'test', turn_id: 'turn_1' };
    const scenario: Scenario = {
      name: 'long',
      description: 'many steps',
      steps: [
        evt(createEvent('turn.begin', { turn_id: 'turn_1', user_input: 'test', input_kind: 'user' }, opts)),
        evt(createEvent('step.begin', { step: 1 }, opts)),
        delay(50),
        evt(createEvent('content.delta', { type: 'text', text: 'chunk 1' }, opts)),
        delay(50),
        evt(createEvent('content.delta', { type: 'text', text: 'chunk 2' }, opts)),
        delay(50),
        evt(createEvent('content.delta', { type: 'text', text: 'chunk 3' }, opts)),
        evt(createEvent('turn.end', { turn_id: 'turn_1', reason: 'done', success: true }, opts)),
      ],
    };

    // Cancel during iteration
    const events: WireMessage[] = [];
    for await (const e of gen.generate(scenario, 'test', 'turn_1')) {
      events.push(e);
      if (e.method === 'step.begin') {
        gen.cancel();
      }
    }

    // Should have: turn.begin, step.begin, then step.interrupted + turn.end from cancellation
    expect(events.length).toBeGreaterThanOrEqual(2);
    const lastTwo = events.slice(-2);
    expect(lastTwo[0]!.method).toBe('step.interrupted');
    expect(lastTwo[1]!.method).toBe('turn.end');
  });

  it('resets cancellation state', () => {
    const gen = new MockEventGenerator({ delayMultiplier: 0 });
    gen.cancel();
    expect(gen.isCancelled).toBe(true);
    gen.reset();
    expect(gen.isCancelled).toBe(false);
  });
});

// ── Scenario completeness tests ───────────────────────────────────────

describe('Scenarios', () => {
  const gen = new MockEventGenerator({ delayMultiplier: 0 });

  it('simple-chat scenario has turn.begin and turn.end', async () => {
    const events = await collect(gen.generate(simpleChatScenario('hello', 'test', 'turn_1'), 'test', 'turn_1'));

    expect(events[0]!.method).toBe('turn.begin');
    expect(events[events.length - 1]!.method).toBe('turn.end');

    // Should contain think and text content
    const methods = events.map((e) => e.method);
    expect(methods).toContain('content.delta');
    expect(methods).toContain('step.begin');
    expect(methods).toContain('status.update');
  });

  it('simple-chat scenario contains think and text content deltas', async () => {
    const events = await collect(gen.generate(simpleChatScenario('hello', 'test', 'turn_1'), 'test', 'turn_1'));

    const contentEvents = events.filter((e) => e.method === 'content.delta');
    const types = contentEvents.map((e) => {
      const data = e.data as { type: string };
      return data.type;
    });

    expect(types).toContain('think');
    expect(types).toContain('text');
  });

  it('tool-call scenario has tool.call and tool.result', async () => {
    const events = await collect(gen.generate(toolCallScenario('list files', 'test', 'turn_1'), 'test', 'turn_1'));

    const methods = events.map((e) => e.method);
    expect(methods).toContain('turn.begin');
    expect(methods).toContain('tool.call');
    expect(methods).toContain('tool.result');
    expect(methods).toContain('turn.end');
  });

  it('approval scenario flat has approval.request event', async () => {
    const events = await collect(gen.generate(approvalScenarioFlat('write a file'), '__mock__', 'turn_0'));

    const methods = events.map((e) => e.method);
    expect(methods).toContain('approval.request');
    expect(methods).toContain('tool.call');
    expect(methods).toContain('tool.result');
    expect(methods).toContain('turn.end');
  });

  it('thinking scenario has many think content deltas', async () => {
    const events = await collect(gen.generate(thinkingScenario('analyze this'), '__mock__', 'turn_0'));

    const thinkParts = events.filter(
      (e) => e.method === 'content.delta' && (e.data as { type: string }).type === 'think',
    );
    // Should have multiple think chunks
    expect(thinkParts.length).toBeGreaterThanOrEqual(5);
  });

  it('btw scenario has turn.begin and turn.end', async () => {
    const events = await collect(gen.generate(btwScenario('what is TypeScript?'), '__mock__', 'turn_btw'));

    const methods = events.map((e) => e.method);
    expect(methods[0]).toBe('turn.begin');
    expect(methods[methods.length - 1]).toBe('turn.end');
    expect(methods).toContain('content.delta');
  });
});
