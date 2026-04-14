import { describe, it, expect } from 'vitest';
import type { WireEvent } from '../src/types.js';
import { MockEventGenerator, event, delay } from '../src/mock-event-generator.js';
import type { Scenario } from '../src/mock-event-generator.js';
import { simpleChatScenario } from '../src/scenarios/simple-chat.js';
import { toolCallScenario } from '../src/scenarios/tool-call.js';
import { thinkingScenario } from '../src/scenarios/thinking.js';
import { btwScenario } from '../src/scenarios/btw.js';
import { approvalScenarioFlat } from '../src/scenarios/approval.js';

// ── Helpers ───────────────────────────────────────────────────────────

async function collect(source: AsyncIterable<WireEvent>): Promise<WireEvent[]> {
  const items: WireEvent[] = [];
  for await (const item of source) {
    items.push(item);
  }
  return items;
}

// ── MockEventGenerator ────────────────────────────────────────────────

describe('MockEventGenerator', () => {
  it('generates events from a simple scenario', async () => {
    const gen = new MockEventGenerator({ delayMultiplier: 0 });
    const scenario: Scenario = {
      name: 'test',
      description: 'test scenario',
      steps: [
        event({ type: 'TurnBegin', userInput: 'hello' }),
        event({ type: 'StepBegin', n: 1 }),
        event({ type: 'ContentPart', part: { type: 'text', text: 'Hi!' } }),
        event({ type: 'TurnEnd' }),
      ],
    };

    const events = await collect(gen.generate(scenario));

    expect(events).toHaveLength(4);
    expect(events[0]!.type).toBe('TurnBegin');
    expect(events[1]!.type).toBe('StepBegin');
    expect(events[2]!.type).toBe('ContentPart');
    expect(events[3]!.type).toBe('TurnEnd');
  });

  it('handles delays with zero multiplier (instant)', async () => {
    const gen = new MockEventGenerator({ delayMultiplier: 0 });
    const scenario: Scenario = {
      name: 'delayed',
      description: 'scenario with delays',
      steps: [
        event({ type: 'TurnBegin', userInput: 'test' }),
        delay(1000), // Would be 1 second, but multiplier is 0
        event({ type: 'TurnEnd' }),
      ],
    };

    const start = Date.now();
    const events = await collect(gen.generate(scenario));
    const elapsed = Date.now() - start;

    expect(events).toHaveLength(2);
    expect(elapsed).toBeLessThan(100); // Should be nearly instant
  });

  it('emits StepInterrupted + TurnEnd when cancelled', async () => {
    const gen = new MockEventGenerator({ delayMultiplier: 0 });
    const scenario: Scenario = {
      name: 'long',
      description: 'many steps',
      steps: [
        event({ type: 'TurnBegin', userInput: 'test' }),
        event({ type: 'StepBegin', n: 1 }),
        delay(50),
        event({ type: 'ContentPart', part: { type: 'text', text: 'chunk 1' } }),
        delay(50),
        event({ type: 'ContentPart', part: { type: 'text', text: 'chunk 2' } }),
        delay(50),
        event({ type: 'ContentPart', part: { type: 'text', text: 'chunk 3' } }),
        event({ type: 'TurnEnd' }),
      ],
    };

    // Cancel during iteration
    const events: WireEvent[] = [];
    for await (const e of gen.generate(scenario)) {
      events.push(e);
      if (e.type === 'StepBegin') {
        gen.cancel();
      }
    }

    // Should have: TurnBegin, StepBegin, then StepInterrupted + TurnEnd from cancellation
    expect(events.length).toBeGreaterThanOrEqual(2);
    const lastTwo = events.slice(-2);
    expect(lastTwo[0]!.type).toBe('StepInterrupted');
    expect(lastTwo[1]!.type).toBe('TurnEnd');
  });

  it('resets cancellation state', async () => {
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

  it('simple-chat scenario has TurnBegin and TurnEnd', async () => {
    const events = await collect(gen.generate(simpleChatScenario('hello')));

    expect(events[0]!.type).toBe('TurnBegin');
    expect(events[events.length - 1]!.type).toBe('TurnEnd');

    // Should contain think and text content
    const types = events.map((e) => e.type);
    expect(types).toContain('ContentPart');
    expect(types).toContain('StepBegin');
    expect(types).toContain('StatusUpdate');
  });

  it('simple-chat scenario contains think and text parts', async () => {
    const events = await collect(gen.generate(simpleChatScenario('hello')));

    const contentEvents = events.filter((e) => e.type === 'ContentPart');
    const partTypes = contentEvents.map((e) => {
      if (e.type === 'ContentPart') return e.part.type;
      return null;
    });

    expect(partTypes).toContain('think');
    expect(partTypes).toContain('text');
  });

  it('tool-call scenario has ToolCall and ToolResult', async () => {
    const events = await collect(gen.generate(toolCallScenario('list files')));

    const types = events.map((e) => e.type);
    expect(types).toContain('TurnBegin');
    expect(types).toContain('ToolCall');
    expect(types).toContain('ToolResult');
    expect(types).toContain('TurnEnd');
  });

  it('approval scenario has ApprovalRequest and ApprovalResponse', async () => {
    const events = await collect(gen.generate(approvalScenarioFlat('write a file')));

    const types = events.map((e) => e.type);
    expect(types).toContain('ApprovalRequest');
    expect(types).toContain('ApprovalResponse');
    expect(types).toContain('ToolCall');
    expect(types).toContain('ToolResult');
    expect(types).toContain('TurnEnd');
  });

  it('thinking scenario has many think parts', async () => {
    const events = await collect(gen.generate(thinkingScenario('analyze this')));

    const thinkParts = events.filter(
      (e) => e.type === 'ContentPart' && e.part.type === 'think',
    );
    // Should have multiple think chunks
    expect(thinkParts.length).toBeGreaterThanOrEqual(5);
  });

  it('btw scenario has BtwBegin and BtwEnd', async () => {
    const events = await collect(gen.generate(btwScenario('what is TypeScript?')));

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('BtwBegin');
    expect(types[types.length - 1]).toBe('BtwEnd');
    expect(types).toContain('ContentPart');
  });
});
