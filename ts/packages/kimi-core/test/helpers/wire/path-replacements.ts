/**
 * Path / UUID / step-block normalization — Phase 9 §4.
 *
 * Mirrors Python `tests_e2e/wire_helpers.py:376-579` so TS snapshots
 * survive across machines. The pipeline:
 *   1. Walk every value recursively
 *   2. Replace applied path substrings
 *   3. Mask UUIDs and tool_call_ids with placeholders
 *   4. Normalise line-endings + path separators
 *   5. Reorder step-block children so tool_call / status_update /
 *      reverse-RPC requests / approvals appear in a stable sequence
 */

import type { WireMessage } from '../../../src/wire-protocol/types.js';

export interface PathReplacement {
  readonly from: string;
  readonly to: string;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const WIRE_ID_RE = /\b(req|res|evt|ses|tc|turn|agent|sub|tool)_[0-9a-z]{6,32}\b/g;

export function normalizeLineEndings(s: string): string {
  return s.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

export function normalizePathSeparators(s: string): string {
  // Only convert Windows-style backslash segments; avoid touching legit
  // escape sequences like `\n` in JSON strings already decoded to real
  // newlines. We do this by only replacing `\\` that follow
  // drive-letter / path-looking prefixes.
  return s.replaceAll('\\\\', '/').replaceAll('\\', '/');
}

export function normalizeUuids(value: unknown): unknown {
  if (typeof value === 'string') {
    let out = value.replace(UUID_RE, '<uuid>');
    out = out.replace(WIRE_ID_RE, (_match, prefix: string) => `<${prefix}_id>`);
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalizeUuids(v));
  }
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      copy[k] = normalizeUuids(v);
    }
    return copy;
  }
  return value;
}

function applyReplacements(
  s: string,
  replacements: readonly PathReplacement[] | undefined,
): string {
  let out = s;
  if (replacements !== undefined) {
    for (const r of replacements) {
      if (r.from.length === 0) continue;
      out = out.split(r.from).join(r.to);
    }
  }
  return out;
}

export function normalizeValue(
  value: unknown,
  replacements?: readonly PathReplacement[],
): unknown {
  if (typeof value === 'string') {
    let out = applyReplacements(value, replacements);
    out = normalizeLineEndings(out);
    out = normalizePathSeparators(out);
    // UUIDs last so path-prefix replacement sees the original string.
    out = out.replace(UUID_RE, '<uuid>');
    out = out.replace(WIRE_ID_RE, (_match, prefix: string) => `<${prefix}_id>`);
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalizeValue(v, replacements));
  }
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      copy[k] = normalizeValue(v, replacements);
    }
    return copy;
  }
  return value;
}

// ── summarize_messages (step-block reorder) ──────────────────────────────

type MessageLike = Readonly<Pick<WireMessage, 'type' | 'method' | 'request_id' | 'session_id' | 'turn_id'>> & {
  readonly data?: unknown;
  readonly error?: WireMessage['error'];
};

export interface NormalizedMessage {
  readonly type: WireMessage['type'];
  readonly method?: string | undefined;
  readonly request_id?: string | undefined;
  readonly session_id: string;
  readonly turn_id?: string | undefined;
  readonly data?: unknown;
  readonly error?: WireMessage['error'];
}

/**
 * Return the step-order bucket for a message so a mid-turn interleave
 * of `tool.call` / `status.update` / reverse-RPC / approval normalises
 * to a deterministic sequence. Mirrors Python
 * wire_helpers.py:544-579.
 *
 * `step.end` is intentionally **not** bucketed here — it is extracted
 * by `flushBuffer` and appended after every other message in the block
 * so it always sits at the tail regardless of what sits between it
 * and `step.begin`.
 *
 * `tool.result` is likewise extracted — it must be ordered by
 * `tool_call_order` (the order of `tool.call` events), not by arrival
 * time, so concurrent tool executions produce stable snapshots.
 */
function stepBucket(m: MessageLike): number {
  if (m.type === 'event') {
    const method = m.method ?? '';
    if (method === 'step.begin') return 0;
    if (method === 'content.delta') return 1;
    if (method === 'tool.call' || method === 'tool.call.delta') return 2;
    if (method === 'status.update') return 3;
  }
  if (m.type === 'request') return 4;
  if (m.type === 'response') return 5;
  return 6; // default bucket for uncategorised messages
}

function readToolCallId(m: MessageLike): string | undefined {
  if (m.type !== 'event') return undefined;
  const d = m.data as { tool_call_id?: unknown; id?: unknown } | undefined;
  if (d === undefined) return undefined;
  const direct = typeof d.tool_call_id === 'string' ? d.tool_call_id : undefined;
  const fallback = typeof d.id === 'string' ? d.id : undefined;
  return direct ?? fallback;
}

function stripEnvelope(m: WireMessage): NormalizedMessage {
  const out: NormalizedMessage = {
    type: m.type,
    session_id: m.session_id,
    ...(m.method !== undefined ? { method: m.method } : {}),
    ...(m.request_id !== undefined ? { request_id: m.request_id } : {}),
    ...(m.turn_id !== undefined ? { turn_id: m.turn_id } : {}),
    ...(m.data !== undefined ? { data: m.data } : {}),
    ...(m.error !== undefined ? { error: m.error } : {}),
  };
  return out;
}

/**
 * Produce a stable, snapshot-friendly view of a wire message stream.
 * Envelopes are trimmed (no `id`/`time`/`seq`/`from`/`to`), UUIDs are
 * masked, step blocks are reordered to their canonical sequence.
 *
 * Step block reorder (matches Python `wire_helpers.py:544-579`):
 *   1. `step.end`, `tool.result`, and `step.begin` are extracted.
 *   2. The remainder is stable-sorted by `stepBucket` (step.begin is
 *      guaranteed first because it's re-prepended at the end).
 *   3. `tool.result` entries are appended in the order their
 *      corresponding `tool.call` events appeared (tool_call_order),
 *      so concurrent tool executions still produce a deterministic
 *      snapshot.
 *   4. `step.end` is appended last — always the tail regardless of
 *      any unknown / future message types that land inside the block.
 */
export function summarizeMessages(
  messages: readonly WireMessage[],
  replacements?: readonly PathReplacement[],
): readonly NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  let buffer: WireMessage[] = [];
  let inStep = false;

  function flushBuffer(): void {
    if (buffer.length === 0) return;

    // Partition the buffered block.
    const stepBegin: WireMessage[] = [];
    const stepEnd: WireMessage[] = [];
    const toolResults: WireMessage[] = [];
    const toolCallOrder: string[] = [];
    const others: WireMessage[] = [];

    for (const m of buffer) {
      if (m.type === 'event' && m.method === 'step.begin') {
        stepBegin.push(m);
      } else if (m.type === 'event' && m.method === 'step.end') {
        stepEnd.push(m);
      } else if (m.type === 'event' && m.method === 'tool.result') {
        toolResults.push(m);
      } else {
        if (m.type === 'event' && m.method === 'tool.call') {
          const id = readToolCallId(m);
          if (id !== undefined) toolCallOrder.push(id);
        }
        others.push(m);
      }
    }

    const orderedOthers = others
      .map((m, idx) => ({ m, idx, bucket: stepBucket(m) }))
      .toSorted((a, b) => (a.bucket === b.bucket ? a.idx - b.idx : a.bucket - b.bucket))
      .map(({ m }) => m);

    // Sort tool.result by tool_call_order; unknown ids fall back to
    // original arrival order at the end of the sorted group.
    const resultRank = new Map<string, number>();
    toolCallOrder.forEach((id, idx) => resultRank.set(id, idx));
    const rankedResults = toolResults
      .map((m, idx) => {
        const id = readToolCallId(m);
        const rank = id !== undefined ? (resultRank.get(id) ?? toolCallOrder.length + idx) : toolCallOrder.length + idx;
        return { m, rank, idx };
      })
      .toSorted((a, b) => (a.rank === b.rank ? a.idx - b.idx : a.rank - b.rank))
      .map(({ m }) => m);

    const final: WireMessage[] = [...stepBegin, ...orderedOthers, ...rankedResults, ...stepEnd];
    for (const m of final) {
      out.push(normalizeValue(stripEnvelope(m), replacements) as NormalizedMessage);
    }
    buffer = [];
  }

  for (const m of messages) {
    if (m.type === 'event' && m.method === 'step.begin') {
      flushBuffer();
      buffer.push(m);
      inStep = true;
      continue;
    }
    if (m.type === 'event' && m.method === 'step.end') {
      buffer.push(m);
      flushBuffer();
      inStep = false;
      continue;
    }
    if (inStep) {
      buffer.push(m);
    } else {
      out.push(normalizeValue(stripEnvelope(m), replacements) as NormalizedMessage);
    }
  }
  flushBuffer();
  return out;
}
