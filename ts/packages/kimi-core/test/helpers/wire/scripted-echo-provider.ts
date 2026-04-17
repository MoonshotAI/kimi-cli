/**
 * Scripted-echo KosongAdapter helper — Phase 14 §4.1.
 *
 * Ports the Python scripted-echo provider script format used by
 *   `/Users/moonshot/Developer/kimi-cli/tests/e2e/test_media_e2e.py:170-188`
 *
 * Each script is a '\n'-joined block of `key: value` lines, e.g.:
 *   id: scripted-1
 *   usage: {"input_other": 11, "output": 5}
 *   think: analyzing the image
 *   text: The image shows a simple scene.
 *
 * `parseScriptedEchoText(...)` unwraps the block into a `ScriptedTurn`
 * shape that `FakeKosongAdapter` can consume. `scriptedTurnsFromText`
 * runs the parser over the canonical `["<block1>", "<block2>"]` JSON
 * format that Python writes to disk.
 *
 * NOTE: this file introduces NO new source — it's a test helper that
 * wraps the existing `FakeKosongAdapter.turns` surface.
 */

import type { ScriptedTurn } from '../kosong/script-builder.js';
import type { TokenUsage } from '../../../src/soul/types.js';

export interface ScriptedEchoBlock {
  readonly id?: string;
  readonly text?: string;
  readonly think?: string;
  readonly usage?: TokenUsage;
}

function parseUsage(value: string): TokenUsage | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, number>;
    const usage: TokenUsage = {
      input: parsed['input_other'] ?? parsed['input'] ?? 0,
      output: parsed['output'] ?? 0,
    };
    if (parsed['cache_read'] !== undefined) {
      return { ...usage, cache_read: parsed['cache_read'] };
    }
    return usage;
  } catch {
    return undefined;
  }
}

/** Parse a single `key: value`-block script into a `ScriptedTurn`. */
export function parseScriptedEchoText(block: string): ScriptedTurn {
  const out: { text?: string; think?: string; usage?: TokenUsage } = {};
  for (const rawLine of block.split('\n')) {
    const idx = rawLine.indexOf(':');
    if (idx === -1) continue;
    const key = rawLine.slice(0, idx).trim();
    const value = rawLine.slice(idx + 1).trim();
    switch (key) {
      case 'text':
        out.text = value;
        break;
      case 'think':
        out.think = value;
        break;
      case 'usage': {
        const usage = parseUsage(value);
        if (usage !== undefined) out.usage = usage;
        break;
      }
      case 'id':
        // id is currently informational — adapter doesn't need it.
        break;
      default:
        // Unknown keys are ignored; mirrors the Python provider.
        break;
    }
  }
  return out;
}

/** Parse a JSON array of blocks (the Python disk format) into turns. */
export function scriptedTurnsFromJson(raw: string): readonly ScriptedTurn[] {
  const arr = JSON.parse(raw) as readonly string[];
  return arr.map(parseScriptedEchoText);
}
