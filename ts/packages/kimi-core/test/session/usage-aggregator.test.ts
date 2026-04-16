/**
 * usage-aggregator tests — wire.jsonl token replay + 5s in-memory cache.
 *
 * Token cost is intentionally always 0 (Slice 5.1 D1).
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  aggregateUsage,
  createCachedUsageAggregator,
} from '../../src/session/usage-aggregator.js';

let tmp: string;

async function writeWire(name: string, lines: object[]): Promise<string> {
  const path = join(tmp, name);
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  return path;
}

beforeEach(async () => {
  tmp = join(tmpdir(), `kimi-usage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmp, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('aggregateUsage', () => {
  it('returns zeros for empty file', async () => {
    const path = await writeWire('wire.jsonl', []);
    const totals = await aggregateUsage(path);
    expect(totals).toEqual({
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
      total_cost_usd: 0,
    });
  });

  it('returns zeros for missing file', async () => {
    const totals = await aggregateUsage(join(tmp, 'does-not-exist.jsonl'));
    expect(totals.total_input_tokens).toBe(0);
    expect(totals.total_cost_usd).toBe(0);
  });

  it('sums usage across multiple turn_end records', async () => {
    const path = await writeWire('wire.jsonl', [
      {
        type: 'turn_end',
        seq: 5,
        time: 1,
        turn_id: 't_1',
        agent_type: 'main',
        success: true,
        reason: 'done',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 10 },
      },
      {
        type: 'turn_end',
        seq: 10,
        time: 2,
        turn_id: 't_2',
        agent_type: 'main',
        success: true,
        reason: 'done',
        usage: {
          input_tokens: 200,
          output_tokens: 75,
          cache_read_tokens: 20,
          cache_write_tokens: 5,
        },
      },
    ]);
    const totals = await aggregateUsage(path);
    expect(totals.total_input_tokens).toBe(300);
    expect(totals.total_output_tokens).toBe(125);
    expect(totals.total_cache_read_tokens).toBe(30);
    expect(totals.total_cache_write_tokens).toBe(5);
    expect(totals.total_cost_usd).toBe(0); // D1 — always 0
  });

  it('skips turn_end records without usage block', async () => {
    const path = await writeWire('wire.jsonl', [
      {
        type: 'turn_end',
        seq: 1,
        time: 1,
        turn_id: 't_1',
        agent_type: 'main',
        success: false,
        reason: 'cancelled',
      },
    ]);
    const totals = await aggregateUsage(path);
    expect(totals.total_input_tokens).toBe(0);
  });

  it('ignores non-turn_end records (turn_begin, user_message, etc.)', async () => {
    const path = await writeWire('wire.jsonl', [
      {
        type: 'turn_begin',
        seq: 1,
        time: 1,
        turn_id: 't_1',
        agent_type: 'main',
        input_kind: 'user',
      },
      {
        type: 'user_message',
        seq: 2,
        time: 1,
        turn_id: 't_1',
        content: 'hi',
      },
      {
        type: 'turn_end',
        seq: 3,
        time: 1,
        turn_id: 't_1',
        agent_type: 'main',
        success: true,
        reason: 'done',
        usage: { input_tokens: 50, output_tokens: 10 },
      },
    ]);
    const totals = await aggregateUsage(path);
    expect(totals.total_input_tokens).toBe(50);
  });

  it('skips corrupt JSON lines without throwing', async () => {
    const path = join(tmp, 'wire.jsonl');
    await writeFile(
      path,
      [
        '{not json',
        JSON.stringify({
          type: 'turn_end',
          seq: 1,
          time: 1,
          turn_id: 't_1',
          agent_type: 'main',
          success: true,
          reason: 'done',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        '{also not json',
      ].join('\n') + '\n',
      'utf-8',
    );
    const totals = await aggregateUsage(path);
    expect(totals.total_input_tokens).toBe(10);
    expect(totals.total_output_tokens).toBe(5);
  });

  it('falls back to assistant_message.usage when turn_end has no usage (Python migration)', async () => {
    // Simulates a Python-migrated wire.jsonl: per-step usage is on
    // assistant_message records; turn_end has no usage block.
    const path = await writeWire('wire.jsonl', [
      {
        type: 'assistant_message',
        seq: 1,
        time: 1,
        turn_id: 't_python',
        text: 'step 1',
        think: null,
        tool_calls: [],
        model: 'kimi-k2.5',
        usage: { input_tokens: 100, output_tokens: 25, cache_read_tokens: 8 },
      },
      {
        type: 'assistant_message',
        seq: 2,
        time: 2,
        turn_id: 't_python',
        text: 'step 2',
        think: null,
        tool_calls: [],
        model: 'kimi-k2.5',
        usage: { input_tokens: 50, output_tokens: 30 },
      },
      {
        type: 'turn_end',
        seq: 3,
        time: 3,
        turn_id: 't_python',
        agent_type: 'main',
        success: true,
        reason: 'done',
        // no usage block — mirrors Python wire migration
      },
    ]);
    const totals = await aggregateUsage(path);
    expect(totals.total_input_tokens).toBe(150);
    expect(totals.total_output_tokens).toBe(55);
    expect(totals.total_cache_read_tokens).toBe(8);
  });

  it('does not double-count when turn_end has its own usage (native TS)', async () => {
    // Native TS sessions put cumulative usage on turn_end; per-message
    // assistant_message usage must not be added on top.
    const path = await writeWire('wire.jsonl', [
      {
        type: 'assistant_message',
        seq: 1,
        time: 1,
        turn_id: 't_native',
        text: 'step',
        think: null,
        tool_calls: [],
        model: 'kimi-k2.5',
        usage: { input_tokens: 999, output_tokens: 999 },
      },
      {
        type: 'turn_end',
        seq: 2,
        time: 2,
        turn_id: 't_native',
        agent_type: 'main',
        success: true,
        reason: 'done',
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    ]);
    const totals = await aggregateUsage(path);
    // Should reflect only the turn_end value, not 999 + 100
    expect(totals.total_input_tokens).toBe(100);
    expect(totals.total_output_tokens).toBe(50);
  });

  it('flushes per-turn fallback for crashed turns without turn_end', async () => {
    // Crash mid-turn: assistant_message landed but no turn_end. User
    // should still get credit for tokens consumed before the crash.
    const path = await writeWire('wire.jsonl', [
      {
        type: 'assistant_message',
        seq: 1,
        time: 1,
        turn_id: 't_crashed',
        text: 'step',
        think: null,
        tool_calls: [],
        model: 'kimi-k2.5',
        usage: { input_tokens: 42, output_tokens: 13 },
      },
    ]);
    const totals = await aggregateUsage(path);
    expect(totals.total_input_tokens).toBe(42);
    expect(totals.total_output_tokens).toBe(13);
  });

  it('handles missing optional fields (cache_read_tokens / cache_write_tokens)', async () => {
    const path = await writeWire('wire.jsonl', [
      {
        type: 'turn_end',
        seq: 1,
        time: 1,
        turn_id: 't_1',
        agent_type: 'main',
        success: true,
        reason: 'done',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);
    const totals = await aggregateUsage(path);
    expect(totals.total_cache_read_tokens).toBe(0);
    expect(totals.total_cache_write_tokens).toBe(0);
  });
});

describe('createCachedUsageAggregator', () => {
  it('reuses cached value within ttl window', async () => {
    const path = await writeWire('wire.jsonl', [
      {
        type: 'turn_end',
        seq: 1,
        time: 1,
        turn_id: 't_1',
        agent_type: 'main',
        success: true,
        reason: 'done',
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    ]);
    let now = 1000;
    const aggregator = vi.fn().mockResolvedValue({
      total_input_tokens: 100,
      total_output_tokens: 50,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
      total_cost_usd: 0,
    });
    const cached = createCachedUsageAggregator({
      ttlMs: 5000,
      now: () => now,
      aggregator,
    });

    await cached(path);
    await cached(path);
    expect(aggregator).toHaveBeenCalledTimes(1);
  });

  it('re-aggregates after ttl expires', async () => {
    let now = 1000;
    const aggregator = vi.fn().mockResolvedValue({
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
      total_cost_usd: 0,
    });
    const cached = createCachedUsageAggregator({ ttlMs: 5000, now: () => now, aggregator });

    await cached('wire1.jsonl');
    now = 6500; // beyond 5s TTL
    await cached('wire1.jsonl');
    expect(aggregator).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent misses for same path (in-flight dedup)', async () => {
    let calls = 0;
    let resolveInner!: (v: SessionUsageTotals) => void;
    const innerPromise = new Promise<SessionUsageTotals>((resolve) => {
      resolveInner = resolve;
    });
    const aggregator = vi.fn().mockImplementation(async () => {
      calls += 1;
      return innerPromise;
    });
    const cached = createCachedUsageAggregator({ ttlMs: 5000, now: () => 1000, aggregator });

    // Fire two concurrent calls before the inner aggregator resolves.
    const p1 = cached('wire1.jsonl');
    const p2 = cached('wire1.jsonl');
    const p3 = cached('wire1.jsonl');
    expect(calls).toBe(1); // dedup: only one inner call

    resolveInner({
      total_input_tokens: 7,
      total_output_tokens: 3,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
      total_cost_usd: 0,
    });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    expect(r1.total_input_tokens).toBe(7);
  });

  it('caches each path independently', async () => {
    const aggregator = vi.fn().mockResolvedValue({
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
      total_cost_usd: 0,
    });
    const cached = createCachedUsageAggregator({ ttlMs: 5000, now: () => 1000, aggregator });

    await cached('wire1.jsonl');
    await cached('wire2.jsonl');
    expect(aggregator).toHaveBeenCalledTimes(2);
  });

  it('invalidate(path) forces re-aggregation', async () => {
    const aggregator = vi.fn().mockResolvedValue({
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
      total_cost_usd: 0,
    });
    const cached = createCachedUsageAggregator({ ttlMs: 5000, now: () => 1000, aggregator });
    const fn = cached;

    await fn('wire1.jsonl');
    fn.invalidate('wire1.jsonl');
    await fn('wire1.jsonl');
    expect(aggregator).toHaveBeenCalledTimes(2);
  });
});
