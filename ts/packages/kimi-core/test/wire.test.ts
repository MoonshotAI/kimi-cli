import { describe, expect, test } from 'vitest';

import { createEventEnvelope, WIRE_PROTOCOL_VERSION } from '../src/wire/index.js';
import type { TurnBeginEvent, TurnEndEvent, WireEvent } from '../src/wire/index.js';

describe('Wire protocol', () => {
  test('protocol version is 2.1', () => {
    expect(WIRE_PROTOCOL_VERSION).toBe('2.1');
  });

  test('createEventEnvelope produces valid envelope', () => {
    const event: TurnBeginEvent = {
      type: 'turn.begin',
      turnId: 1,
      userInput: 'hello',
      inputKind: 'user',
    };

    const envelope = createEventEnvelope('ses_001', event, 1);

    expect(envelope.sessionId).toBe('ses_001');
    expect(envelope.type).toBe('event');
    expect(envelope.from).toBe('core');
    expect(envelope.to).toBe('client');
    expect(envelope.method).toBe('turn.begin');
    expect(envelope.turnId).toBe(1);
    expect(envelope.data).toBe(event);
    expect(envelope.id).toMatch(/^evt_/);
    expect(envelope.time).toBeGreaterThan(0);
    expect(envelope.seq).toBeGreaterThan(0);
  });

  test('WireEvent discriminated union narrows correctly', () => {
    const events: WireEvent[] = [
      { type: 'step.begin', stepNumber: 0 },
      { type: 'content.delta', part: { type: 'text', text: 'hello' } },
      { type: 'step.end' },
    ];

    const textDeltas = events.filter(
      (e): e is Extract<WireEvent, { type: 'content.delta' }> => e.type === 'content.delta',
    );

    expect(textDeltas).toHaveLength(1);
    expect(textDeltas[0]?.part.type).toBe('text');
  });

  test('TurnEndEvent.reason accepts max_steps', () => {
    // Type-level assertion: the value must compile against TurnEndEvent.reason.
    const event: TurnEndEvent = {
      type: 'turn.end',
      turnId: 1,
      reason: 'max_steps',
      success: false,
    };
    expect(event.reason).toBe('max_steps');
  });
});
