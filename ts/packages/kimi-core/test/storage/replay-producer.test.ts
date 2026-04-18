/**
 * Phase 22 — replayWire producer hard-check (T2).
 *
 * After parsing the metadata header (and the existing protocol_version
 * compatibility check), replayWire must do a hard producer check:
 *   - metadata has no `producer` field  → throw UnsupportedProducerError
 *     with producerKind='legacy', reason='metadata-missing-producer'
 *   - metadata has `producer.kind !== 'typescript'` → throw
 *     UnsupportedProducerError with producerKind = that kind,
 *     reason='cross-producer-not-supported'
 *   - metadata has `producer.kind === 'typescript'` → return normally with
 *     `result.producer` carrying the parsed producer object
 *
 * Ordering constraint: protocol_version error has PRIORITY over producer
 * error. metadata-parse failure (entirely absent / garbage first line) goes
 * to WireJournalCorruptError and never reaches producer check.
 *
 * Error message UX: carries a migrationHint explaining the session is
 * incompatible and cannot be resumed on this runtime.
 *
 * Red bar until Step 4 (UnsupportedProducerError + replayWire hard check)
 * lands.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  IncompatibleVersionError,
  UnsupportedProducerError,
  WireJournalCorruptError,
} from '../../src/storage/errors.js';
import { replayWire } from '../../src/storage/replay.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'kimi-replay-producer-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeWire(lines: string[]): Promise<string> {
  const path = join(workDir, 'wire.jsonl');
  await writeFile(path, lines.map((l) => l + '\n').join(''), 'utf8');
  return path;
}

function metadataWithoutProducer(version = '2.1'): string {
  // Legacy / pre-Phase-22 shape — no `producer` field.
  return JSON.stringify({
    type: 'metadata',
    protocol_version: version,
    created_at: 1712790000000,
    kimi_version: '1.0.0',
  });
}

function metadataWithProducer(
  producerOverride?: { kind?: string; name?: string; version?: string },
  version = '2.1',
): string {
  return JSON.stringify({
    type: 'metadata',
    protocol_version: version,
    created_at: 1712790000000,
    kimi_version: producerOverride?.version ?? '0.1.0',
    producer: {
      kind: producerOverride?.kind ?? 'typescript',
      name: producerOverride?.name ?? '@moonshot-ai/core',
      version: producerOverride?.version ?? '0.1.0',
    },
  });
}

// ── T2.1 — legacy (no producer field) ────────────────────────────────
describe('replayWire — producer hard check: metadata without producer (T2.1)', () => {
  it('throws UnsupportedProducerError with kind=legacy, reason=metadata-missing-producer', async () => {
    const path = await writeWire([
      metadataWithoutProducer('2.1'),
      JSON.stringify({
        type: 'user_message',
        seq: 1,
        time: 1,
        turn_id: 't1',
        content: 'hi',
      }),
    ]);

    let caught: unknown;
    try {
      await replayWire(path, { supportedMajor: 2 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsupportedProducerError);
    const err = caught as UnsupportedProducerError;
    expect(err.producerKind).toBe('legacy');
    expect(err.reason).toBe('metadata-missing-producer');
  });

  it('error message carries an incompatibility + cannot-be-resumed migration hint', async () => {
    const path = await writeWire([metadataWithoutProducer('2.1')]);
    await expect(replayWire(path, { supportedMajor: 2 })).rejects.toThrow(
      /incompatible/i,
    );
    await expect(replayWire(path, { supportedMajor: 2 })).rejects.toThrow(
      /cannot be resumed/i,
    );
  });
});

// ── T2.2 — cross-producer (python) ──────────────────────────────────
describe('replayWire — producer hard check: producer.kind === python (T2.2)', () => {
  it('throws UnsupportedProducerError with kind=python, reason=cross-producer-not-supported', async () => {
    const path = await writeWire([
      metadataWithProducer({ kind: 'python', name: 'kimi-cli', version: '1.2.3' }),
      JSON.stringify({
        type: 'user_message',
        seq: 1,
        time: 1,
        turn_id: 't1',
        content: 'hi',
      }),
    ]);

    let caught: unknown;
    try {
      await replayWire(path, { supportedMajor: 2 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsupportedProducerError);
    const err = caught as UnsupportedProducerError;
    expect(err.producerKind).toBe('python');
    expect(err.reason).toBe('cross-producer-not-supported');
  });

  it('error message includes the string "python" and an incompatibility migration hint', async () => {
    const path = await writeWire([
      metadataWithProducer({ kind: 'python', name: 'kimi-cli', version: '1.0.0' }),
    ]);
    await expect(replayWire(path, { supportedMajor: 2 })).rejects.toThrow(/python/);
    await expect(replayWire(path, { supportedMajor: 2 })).rejects.toThrow(
      /incompatible/i,
    );
    await expect(replayWire(path, { supportedMajor: 2 })).rejects.toThrow(
      /cannot be resumed/i,
    );
  });
});

// ── T2.3 — happy path: producer.kind === typescript ─────────────────
describe('replayWire — producer hard check: producer.kind === typescript (T2.3)', () => {
  it('returns ReplayResult normally with records and transparently exposed producer', async () => {
    const path = await writeWire([
      metadataWithProducer({ kind: 'typescript', name: '@moonshot-ai/core', version: '0.2.0' }),
      JSON.stringify({
        type: 'user_message',
        seq: 1,
        time: 1,
        turn_id: 't1',
        content: 'hi',
      }),
      JSON.stringify({
        type: 'assistant_message',
        seq: 2,
        time: 2,
        turn_id: 't1',
        text: 'hello',
        think: null,
        tool_calls: [],
        model: 'moonshot-v1',
      }),
    ]);

    const result = await replayWire(path, { supportedMajor: 2 });
    expect(result.health).toBe('ok');
    expect(result.records.length).toBe(2);
    expect(result.producer).toEqual({
      kind: 'typescript',
      name: '@moonshot-ai/core',
      version: '0.2.0',
    });
  });
});

// ── T2.4 — ordering: protocol_version error has PRIORITY over producer ─
describe('replayWire — producer vs protocol_version priority (T2.4)', () => {
  it('protocol_version incompatibility surfaces as IncompatibleVersionError, not UnsupportedProducerError', async () => {
    // Build a wire whose protocol_version is in the future AND whose
    // producer field is missing. Protocol-version check must run first.
    const path = await writeWire([metadataWithoutProducer('3.0')]);
    let caught: unknown;
    try {
      await replayWire(path, { supportedMajor: 2 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IncompatibleVersionError);
    expect(caught).not.toBeInstanceOf(UnsupportedProducerError);
  });

  it('protocol_version incompatibility wins even when producer.kind is python', async () => {
    const path = await writeWire([
      metadataWithProducer({ kind: 'python', version: '1.0.0' }, '3.0'),
    ]);
    let caught: unknown;
    try {
      await replayWire(path, { supportedMajor: 2 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IncompatibleVersionError);
  });
});

// ── T2.5 — metadata totally missing still goes to existing corrupt error ─
describe('replayWire — metadata corruption precedence (T2.6)', () => {
  it('empty wire.jsonl raises WireJournalCorruptError (not UnsupportedProducerError)', async () => {
    const path = join(workDir, 'wire.jsonl');
    await writeFile(path, '', 'utf8');
    let caught: unknown;
    try {
      await replayWire(path, { supportedMajor: 2 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WireJournalCorruptError);
    expect(caught).not.toBeInstanceOf(UnsupportedProducerError);
  });

  it('garbage first line raises WireJournalCorruptError, not UnsupportedProducerError', async () => {
    const path = join(workDir, 'wire.jsonl');
    await writeFile(path, '{not-json-at-all\n', 'utf8');
    let caught: unknown;
    try {
      await replayWire(path, { supportedMajor: 2 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WireJournalCorruptError);
    expect(caught).not.toBeInstanceOf(UnsupportedProducerError);
  });
});
