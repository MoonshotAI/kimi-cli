/**
 * Self-test — FakeKosongAdapter (Phase 9 §1).
 */

import { describe, expect, it } from 'vitest';

import {
  FakeKosongAdapter,
  createTextResponseAdapter,
  createToolCallAdapter,
} from '../helpers/index.js';
import type { ChatParams } from '../../src/soul/runtime.js';

function makeParams(overrides?: Partial<ChatParams>): ChatParams {
  return {
    messages: [],
    tools: [],
    model: 'test',
    systemPrompt: '',
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('FakeKosongAdapter', () => {
  it('plays back scripted turns in order', async () => {
    const fake = new FakeKosongAdapter()
      .script({ text: 'one', stopReason: 'end_turn' })
      .script({ text: 'two', stopReason: 'end_turn' });

    const r1 = await fake.chat(makeParams());
    const r2 = await fake.chat(makeParams());
    expect(r1.message.content).toMatchObject([{ type: 'text', text: 'one' }]);
    expect(r2.message.content).toMatchObject([{ type: 'text', text: 'two' }]);
    expect(fake.callCount).toBe(2);
  });

  it('throws when the script is exhausted', async () => {
    const fake = new FakeKosongAdapter({ turns: [{ text: 'only' }] });
    await fake.chat(makeParams());
    await expect(fake.chat(makeParams())).rejects.toThrow(/ran out of scripted/);
  });

  it('emits streaming chunks via onDelta when streaming is "chunked"', async () => {
    const fake = new FakeKosongAdapter({
      turns: [{ text: 'hello world', streaming: 'chunked' }],
    });
    const deltas: string[] = [];
    await fake.chat(makeParams({ onDelta: (d) => deltas.push(d) }));
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe('hello world');
  });

  it('emits explicit chunks when streaming.chunks is given', async () => {
    const fake = new FakeKosongAdapter({
      turns: [{ text: 'ignored', streaming: { chunks: ['foo', 'bar'] } }],
    });
    const deltas: string[] = [];
    await fake.chat(makeParams({ onDelta: (d) => deltas.push(d) }));
    expect(deltas).toEqual(['foo', 'bar']);
  });

  it('injects errors at the specified turn with optional partial delta', async () => {
    const fake = new FakeKosongAdapter({
      turns: [{ text: 'first' }, { text: 'second' }],
      errors: [{ atTurn: 1, error: new Error('boom'), partialDelta: 'sec' }],
    });
    await fake.chat(makeParams());
    const deltas: string[] = [];
    await expect(
      fake.chat(makeParams({ onDelta: (d) => deltas.push(d) })),
    ).rejects.toThrow('boom');
    expect(deltas).toEqual(['sec']);
  });

  it('detects abort when signal fires mid-script', async () => {
    const controller = new AbortController();
    const fake = new FakeKosongAdapter({
      turns: [{ text: 'x' }, { text: 'y' }],
      abortOnTurn: { turn: 0, controller },
    });
    await expect(fake.chat(makeParams({ signal: controller.signal }))).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('replaceUpcoming swaps the tail of the script', async () => {
    const fake = new FakeKosongAdapter();
    fake.script({ text: 'a' }).script({ text: 'b' });
    await fake.chat(makeParams());
    fake.replaceUpcoming([{ text: 'steered' }]);
    const r = await fake.chat(makeParams());
    expect(r.message.content).toMatchObject([{ type: 'text', text: 'steered' }]);
  });

  it('createTextResponseAdapter produces a single end_turn', async () => {
    const fake = createTextResponseAdapter('hi');
    const r = await fake.chat(makeParams());
    expect(r.stopReason).toBe('end_turn');
    expect(fake.callCount).toBe(1);
  });

  it('createToolCallAdapter plays tool_use then end_turn', async () => {
    const fake = createToolCallAdapter('Read', { path: '/x' });
    const r1 = await fake.chat(makeParams());
    expect(r1.stopReason).toBe('tool_use');
    expect(r1.toolCalls[0]?.name).toBe('Read');
    const r2 = await fake.chat(makeParams());
    expect(r2.stopReason).toBe('end_turn');
  });

  it('exposes lastMessages / lastTools / lastSystemPrompt', async () => {
    const fake = new FakeKosongAdapter({ turns: [{ text: 'a' }] });
    await fake.chat(
      makeParams({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] }],
        systemPrompt: 'sys',
      }),
    );
    expect(fake.lastMessages()).toHaveLength(1);
    expect(fake.lastSystemPrompt()).toBe('sys');
    expect(fake.lastTools()).toEqual([]);
  });
});
