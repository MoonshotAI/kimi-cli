/**
 * Token usage aggregator — replays a wire.jsonl and sums usage from
 * `turn_end` records.
 *
 * Slice 5.1 D1 / D2:
 *   - `total_cost_usd` is always 0 (cost computation deferred)
 *   - In-memory 5s LRU cache via `createCachedUsageAggregator`
 *
 * Streaming read avoids loading large transcripts into memory; corrupt
 * lines are skipped silently to match Python's tolerant replay.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface SessionUsageTotals {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  total_cost_usd: number;
}

const ZERO_TOTALS: SessionUsageTotals = {
  total_input_tokens: 0,
  total_output_tokens: 0,
  total_cache_read_tokens: 0,
  total_cache_write_tokens: 0,
  total_cost_usd: 0,
};

interface TurnEndUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

function isUsageObject(value: unknown): value is TurnEndUsage {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Stream-read a wire.jsonl file and sum token usage.
 *
 * Per turn, prefer `turn_end.usage` (native TS sessions emit this with
 * cumulative-by-turn semantics — see `WiredSessionJournal.appendTurnEnd`).
 * Fall back to summing `assistant_message.usage` from the same turn when
 * the `turn_end` record is missing it — this is the Python case: Python
 * sessions only emit per-step usage on `StatusUpdate` which the migration
 * mapper rewrites into `assistant_message.usage`, leaving `turn_end`
 * without a usage block. Without this fallback, migrated Python session
 * `/usage` returns 0.
 *
 * Returns zeros when the file is missing or empty.
 */
export async function aggregateUsage(wirePath: string): Promise<SessionUsageTotals> {
  const totals: SessionUsageTotals = { ...ZERO_TOTALS };

  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(wirePath, { encoding: 'utf-8' });
  } catch {
    return totals;
  }

  // Per-turn assistant usage accumulator: `{ turn_id: usage-totals }`.
  // Flushed into `totals` if the matching turn_end has no usage block.
  const fallbackByTurn = new Map<string, {
    input: number; output: number; cacheRead: number; cacheWrite: number;
  }>();

  function addUsage(into: SessionUsageTotals, u: TurnEndUsage): void {
    into.total_input_tokens += Number(u.input_tokens ?? 0);
    into.total_output_tokens += Number(u.output_tokens ?? 0);
    into.total_cache_read_tokens += Number(u.cache_read_tokens ?? 0);
    into.total_cache_write_tokens += Number(u.cache_write_tokens ?? 0);
  }

  // Wrap the stream so an ENOENT during read is silently treated as "no
  // usage" (matches the missing-file early return semantics).
  return new Promise<SessionUsageTotals>((resolve) => {
    let resolved = false;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      // Flush any per-turn fallback whose turn_end never landed (rare:
      // crash mid-turn). Including these gives the user credit for
      // consumed tokens even if the turn was cut short.
      for (const v of fallbackByTurn.values()) {
        totals.total_input_tokens += v.input;
        totals.total_output_tokens += v.output;
        totals.total_cache_read_tokens += v.cacheRead;
        totals.total_cache_write_tokens += v.cacheWrite;
      }
      resolve(totals);
    };

    stream.on('error', finish);

    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let record: unknown;
      try {
        record = JSON.parse(trimmed);
      } catch {
        return; // skip corrupt line
      }
      if (typeof record !== 'object' || record === null) return;
      const r = record as { type?: unknown; turn_id?: unknown; usage?: unknown };
      const turnId = typeof r.turn_id === 'string' ? r.turn_id : undefined;

      if (r.type === 'assistant_message' && isUsageObject(r.usage) && turnId !== undefined) {
        // Stash per-turn assistant usage; only flushed if turn_end has
        // no usage of its own (Python migration case).
        const existing = fallbackByTurn.get(turnId) ?? {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        };
        existing.input += Number(r.usage.input_tokens ?? 0);
        existing.output += Number(r.usage.output_tokens ?? 0);
        existing.cacheRead += Number(r.usage.cache_read_tokens ?? 0);
        existing.cacheWrite += Number(r.usage.cache_write_tokens ?? 0);
        fallbackByTurn.set(turnId, existing);
        return;
      }

      if (r.type === 'turn_end') {
        if (isUsageObject(r.usage)) {
          // Native TS path: turn_end carries cumulative usage. Discard
          // the per-message fallback for this turn to avoid double-count.
          if (turnId !== undefined) fallbackByTurn.delete(turnId);
          addUsage(totals, r.usage);
        } else if (turnId !== undefined) {
          // Python-migrated path: no turn_end.usage. Promote the
          // accumulated assistant_message usage for this turn.
          const fb = fallbackByTurn.get(turnId);
          if (fb !== undefined) {
            totals.total_input_tokens += fb.input;
            totals.total_output_tokens += fb.output;
            totals.total_cache_read_tokens += fb.cacheRead;
            totals.total_cache_write_tokens += fb.cacheWrite;
            fallbackByTurn.delete(turnId);
          }
        }
      }
    });
    rl.on('close', finish);
    rl.on('error', finish);
  });
}

// ── Cached wrapper ─────────────────────────────────────────────────────

export interface CachedAggregatorOptions {
  /** Cache TTL in ms (default 5000). */
  readonly ttlMs?: number | undefined;
  /** Clock function (test hook, default Date.now). */
  readonly now?: (() => number) | undefined;
  /** Underlying aggregator (test hook, default `aggregateUsage`). */
  readonly aggregator?: ((path: string) => Promise<SessionUsageTotals>) | undefined;
}

export interface CachedUsageAggregator {
  (wirePath: string): Promise<SessionUsageTotals>;
  /** Drop the cached value for a specific wire path (e.g. after rename). */
  invalidate(wirePath: string): void;
  /** Drop all cached values. */
  clear(): void;
}

/**
 * Build a cached aggregator. Each call returns the same totals as long
 * as the cache entry is fresh; expired entries trigger a fresh replay.
 *
 * Cache is per-path (one entry per wire file). Invalidation is exposed
 * for callers that mutate state outside the aggregator's view (rename,
 * compaction rotation).
 */
export function createCachedUsageAggregator(
  options: CachedAggregatorOptions = {},
): CachedUsageAggregator {
  const ttl = options.ttlMs ?? 5000;
  const now = options.now ?? (() => Date.now());
  const inner = options.aggregator ?? aggregateUsage;

  const cache = new Map<string, { value: SessionUsageTotals; ts: number }>();
  // M3 — coalesce concurrent misses for the same path so the underlying
  // file is streamed at most once per cache window.
  const inFlight = new Map<string, Promise<SessionUsageTotals>>();

  const get: CachedUsageAggregator = async (wirePath: string): Promise<SessionUsageTotals> => {
    const entry = cache.get(wirePath);
    if (entry !== undefined && now() - entry.ts < ttl) {
      return entry.value;
    }
    const pending = inFlight.get(wirePath);
    if (pending !== undefined) return pending;

    const promise = inner(wirePath)
      .then((value) => {
        cache.set(wirePath, { value, ts: now() });
        return value;
      })
      .finally(() => {
        inFlight.delete(wirePath);
      });
    inFlight.set(wirePath, promise);
    return promise;
  };

  get.invalidate = (wirePath: string): void => {
    cache.delete(wirePath);
    inFlight.delete(wirePath);
  };

  get.clear = (): void => {
    cache.clear();
    inFlight.clear();
  };

  return get;
}
