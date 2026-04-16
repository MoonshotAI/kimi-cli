/**
 * Event adapter tests — each SoulEvent variant round-trips through
 * `adaptSoulEventToWireMessage` to the expected TUI WireMessage shape.
 */

import type { SoulEvent } from '@moonshot-ai/core';
import { describe, it, expect } from 'vitest';

import { adaptSoulEventToWireMessage } from '../../src/wire/event-adapter.js';

function ctx(turnId: string | undefined = 'turn_1'): {
  sessionId: string;
  turnId: string | undefined;
  nextSeq: () => number;
} {
  let seq = 0;
  return {
    sessionId: 'ses_test',
    turnId,
    nextSeq: () => (seq += 1),
  };
}

function ctxWithoutTurn(): {
  sessionId: string;
  turnId: string | undefined;
  nextSeq: () => number;
} {
  let seq = 0;
  return {
    sessionId: 'ses_test',
    turnId: undefined,
    nextSeq: () => (seq += 1),
  };
}

describe('adaptSoulEventToWireMessage', () => {
  it('maps step.begin', () => {
    const event: SoulEvent = { type: 'step.begin', step: 2 };
    const msg = adaptSoulEventToWireMessage(event, ctx());
    expect(msg).not.toBeNull();
    expect(msg!.method).toBe('step.begin');
    expect(msg!.type).toBe('event');
    expect(msg!.session_id).toBe('ses_test');
    expect(msg!.turn_id).toBe('turn_1');
    expect(msg!.data).toEqual({ step: 2 });
  });

  it('maps step.end', () => {
    const event: SoulEvent = { type: 'step.end', step: 5 };
    const msg = adaptSoulEventToWireMessage(event, ctx());
    expect(msg!.method).toBe('step.end');
    expect(msg!.data).toEqual({});
  });

  it('maps step.interrupted with reason', () => {
    const event: SoulEvent = { type: 'step.interrupted', step: 3, reason: 'aborted' };
    const msg = adaptSoulEventToWireMessage(event, ctx());
    expect(msg!.method).toBe('step.interrupted');
    expect(msg!.data).toEqual({ step: 3, reason: 'aborted' });
  });

  it('maps content.delta to text payload', () => {
    const event: SoulEvent = { type: 'content.delta', delta: 'hello ' };
    const msg = adaptSoulEventToWireMessage(event, ctx());
    expect(msg!.method).toBe('content.delta');
    expect(msg!.data).toEqual({ type: 'text', text: 'hello ' });
  });

  it('maps tool.call with full args', () => {
    const event: SoulEvent = {
      type: 'tool.call',
      toolCallId: 'tc_1',
      name: 'Read',
      args: { path: '/tmp/x' },
    };
    const msg = adaptSoulEventToWireMessage(event, ctx());
    expect(msg!.method).toBe('tool.call');
    expect(msg!.data).toEqual({ id: 'tc_1', name: 'Read', args: { path: '/tmp/x' } });
  });

  it('maps tool.progress with update payload', () => {
    const event: SoulEvent = {
      type: 'tool.progress',
      toolCallId: 'tc_2',
      update: { kind: 'stdout', text: 'line' },
    };
    const msg = adaptSoulEventToWireMessage(event, ctx());
    expect(msg!.method).toBe('tool.progress');
    expect(msg!.data).toEqual({
      tool_call_id: 'tc_2',
      update: { kind: 'stdout', text: 'line' },
    });
  });

  it('maps tool.result with isError flag', () => {
    const event: SoulEvent = {
      type: 'tool.result',
      toolCallId: 'tc_3',
      output: 'file contents',
      isError: false,
    };
    const msg = adaptSoulEventToWireMessage(event, ctx());
    expect(msg!.method).toBe('tool.result');
    expect(msg!.data).toEqual({ tool_call_id: 'tc_3', output: 'file contents' });

    const errEvent: SoulEvent = {
      type: 'tool.result',
      toolCallId: 'tc_4',
      output: 'permission denied',
      isError: true,
    };
    const errMsg = adaptSoulEventToWireMessage(errEvent, ctx());
    expect(errMsg!.data).toEqual({
      tool_call_id: 'tc_4',
      output: 'permission denied',
      is_error: true,
    });
  });

  it('maps compaction.begin and compaction.end', () => {
    const begin = adaptSoulEventToWireMessage({ type: 'compaction.begin' }, ctx());
    expect(begin!.method).toBe('compaction.begin');
    expect(begin!.data).toEqual({});

    const end = adaptSoulEventToWireMessage(
      { type: 'compaction.end', tokensBefore: 100, tokensAfter: 40 },
      ctx(),
    );
    expect(end!.method).toBe('compaction.end');
    expect(end!.data).toEqual({ tokens_before: 100, tokens_after: 40 });
  });

  it('omits turn_id when no current turn is active', () => {
    const msg = adaptSoulEventToWireMessage(
      { type: 'content.delta', delta: 'x' },
      ctxWithoutTurn(),
    );
    expect(msg!.turn_id).toBeUndefined();
  });

  it('allocates monotonically increasing seq numbers', () => {
    let seq = 0;
    const context = {
      sessionId: 'ses_test',
      turnId: 'turn_1',
      nextSeq: () => (seq += 1),
    };
    const a = adaptSoulEventToWireMessage({ type: 'step.begin', step: 1 }, context);
    const b = adaptSoulEventToWireMessage({ type: 'step.end', step: 1 }, context);
    expect(a!.seq).toBe(1);
    expect(b!.seq).toBe(2);
  });
});
