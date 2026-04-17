/**
 * Self-test — normalizeValue / normalizeUuids / summarizeMessages
 * (Phase 9 §4).
 */

import { describe, expect, it } from 'vitest';

import {
  normalizeLineEndings,
  normalizePathSeparators,
  normalizeUuids,
  normalizeValue,
  summarizeMessages,
} from '../helpers/index.js';
import { createWireEvent, createWireRequest, createWireResponse } from '../../src/wire-protocol/message-factory.js';

describe('normalizeLineEndings', () => {
  it('converts CRLF and CR to LF', () => {
    expect(normalizeLineEndings('a\r\nb\rc')).toBe('a\nb\nc');
  });
});

describe('normalizePathSeparators', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizePathSeparators('C:\\Users\\test')).toBe('C:/Users/test');
  });
});

describe('normalizeUuids', () => {
  it('masks canonical UUIDs and wire ids in strings', () => {
    const raw = '123e4567-e89b-12d3-a456-426614174000 req_abcdef012345';
    const out = normalizeUuids(raw);
    expect(out).toBe('<uuid> <req_id>');
  });

  it('recurses into objects and arrays', () => {
    const out = normalizeUuids({
      a: 'req_abc123def456',
      nested: ['tc_abcdef012345'],
    });
    expect(out).toEqual({ a: '<req_id>', nested: ['<tc_id>'] });
  });
});

describe('normalizeValue', () => {
  it('applies path replacements, then uuid masking', () => {
    const v = '/tmp/kimi/ses_01abcd2345 some data';
    const out = normalizeValue(v, [{ from: '/tmp/kimi', to: '<tmp>' }]);
    expect(out).toBe('<tmp>/<ses_id> some data');
  });

  it('preserves numbers / booleans / nulls', () => {
    expect(normalizeValue(1)).toBe(1);
    expect(normalizeValue(true)).toBe(true);
    expect(normalizeValue(null)).toBe(null);
  });
});

describe('summarizeMessages', () => {
  it('strips envelope noise and reorders within a step block', () => {
    const sessionId = 'ses_x';
    const seq = (() => {
      let i = 0;
      return () => i++;
    })();
    const stream = [
      createWireEvent({ method: 'step.begin', sessionId, seq: seq() }),
      // Intentionally out of order — summarizeMessages must reorder
      createWireEvent({ method: 'status.update', sessionId, seq: seq() }),
      createWireEvent({ method: 'content.delta', sessionId, seq: seq() }),
      createWireEvent({
        method: 'tool.call',
        sessionId,
        seq: seq(),
        data: { id: 'tc_a', name: 'X' },
      }),
      createWireEvent({ method: 'step.end', sessionId, seq: seq() }),
    ];
    const out = summarizeMessages(stream);
    expect(out[0]?.method).toBe('step.begin');
    expect(out[1]?.method).toBe('content.delta');
    expect(out[2]?.method).toBe('tool.call');
    expect(out[3]?.method).toBe('status.update');
    expect(out.at(-1)?.method).toBe('step.end');
    for (const m of out) {
      expect(m).not.toHaveProperty('id');
      expect(m).not.toHaveProperty('time');
      expect(m).not.toHaveProperty('seq');
    }
  });

  it('step.end stays at the tail even when an unknown-type event lands inside the block', () => {
    const sessionId = 'ses_xx';
    const seq = (() => {
      let i = 0;
      return () => i++;
    })();
    // `tool.progress` is not specifically bucketed (falls into the
    // default bucket). It must not displace step.end from the tail.
    const stream = [
      createWireEvent({ method: 'step.begin', sessionId, seq: seq() }),
      createWireEvent({ method: 'step.end', sessionId, seq: seq() }),
      createWireEvent({ method: 'tool.progress', sessionId, seq: seq() }),
    ];
    // Wrap above in explicit begin/end:
    const out = summarizeMessages([
      createWireEvent({ method: 'step.begin', sessionId, seq: seq() }),
      createWireEvent({ method: 'tool.progress', sessionId, seq: seq() }),
      createWireEvent({ method: 'step.end', sessionId, seq: seq() }),
    ]);
    expect(out.at(-1)?.method).toBe('step.end');
    void stream;
  });

  it('orders tool.result by tool_call_order, not by arrival order', () => {
    const sessionId = 'ses_z';
    const seq = (() => {
      let i = 0;
      return () => i++;
    })();
    // tool.call goes A then B; tool.result arrives B first then A.
    const stream = [
      createWireEvent({ method: 'step.begin', sessionId, seq: seq() }),
      createWireEvent({
        method: 'tool.call',
        sessionId,
        seq: seq(),
        data: { id: 'tc_a', name: 'A' },
      }),
      createWireEvent({
        method: 'tool.call',
        sessionId,
        seq: seq(),
        data: { id: 'tc_b', name: 'B' },
      }),
      createWireEvent({
        method: 'tool.result',
        sessionId,
        seq: seq(),
        data: { tool_call_id: 'tc_b', output: 'B' },
      }),
      createWireEvent({
        method: 'tool.result',
        sessionId,
        seq: seq(),
        data: { tool_call_id: 'tc_a', output: 'A' },
      }),
      createWireEvent({ method: 'step.end', sessionId, seq: seq() }),
    ];
    const out = summarizeMessages(stream);
    const results = out.filter((m) => m.method === 'tool.result');
    expect(results).toHaveLength(2);
    const r0 = results[0];
    const r1 = results[1];
    expect(r0).toBeDefined();
    expect(r1).toBeDefined();
    expect((r0!.data as { output: string }).output).toBe('A');
    expect((r1!.data as { output: string }).output).toBe('B');
  });

  it('passes through messages outside step blocks unchanged in order', () => {
    const sessionId = 'ses_y';
    const req = createWireRequest({ method: 'session.prompt', sessionId });
    const res = createWireResponse({ requestId: req.id, sessionId });
    const out = summarizeMessages([req, res]);
    expect(out.map((m) => m.type)).toEqual(['request', 'response']);
  });
});
