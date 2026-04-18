/**
 * Phase 22 — JournalWriter metadata-header `producer` field (T1).
 *
 * `WiredJournalWriter.ensureMetadataInit` must stamp the current
 * `getProducerInfo()` snapshot into the metadata header. The legacy
 * `kimi_version` slot stays as a compat field — when the caller doesn't
 * pass `kimiVersion` explicitly, it mirrors `producer.version`; when the
 * caller does pass `kimiVersion`, the explicit value wins (see phase-22
 * risk point 4).
 *
 * Covered behaviours:
 *   - T1.5  first append writes a metadata header whose `producer.kind ===
 *           'typescript'`
 *   - T1.6  setProducerInfo({ version: '0.5.0' }) flows into
 *           `producer.version`
 *   - T1.7  when `kimiVersion` is not explicitly passed, `kimi_version`
 *           mirrors `producer.version`
 *   - T1.8  when `kimiVersion` IS explicitly passed, it wins over
 *           `producer.version` for the `kimi_version` compat field
 *   - T1.9  full happy-path shape: `producer` has kind/name/version, all
 *           strings non-empty
 *
 * Red bar until Step 2 (producer-info) + Step 3 (ensureMetadataInit edit) land.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type LifecycleGate,
  type LifecycleState,
  WiredJournalWriter,
} from '../../src/storage/journal-writer.js';
import {
  _resetProducerInfoForTest,
  setProducerInfo,
} from '../../src/storage/producer-info.js';

class StubGate implements LifecycleGate {
  state: LifecycleState = 'active';
}

async function readFirstLine(path: string): Promise<Record<string, unknown>> {
  const text = await readFile(path, 'utf8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'kimi-journal-producer-'));
  _resetProducerInfoForTest();
});

afterEach(async () => {
  _resetProducerInfoForTest();
  await rm(workDir, { recursive: true, force: true });
});

describe('JournalWriter.ensureMetadataInit — producer field (T1)', () => {
  it('writes a typescript-kind producer on first append (default producer)', async () => {
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      protocolVersion: '2.1',
      now: () => 1712790000000,
    });

    await writer.append({ type: 'user_message', turn_id: 't1', content: 'hi' });
    await writer.flush();

    const header = await readFirstLine(filePath);
    expect(header['type']).toBe('metadata');
    const producer = header['producer'] as Record<string, unknown> | undefined;
    expect(producer).toBeDefined();
    expect(producer!['kind']).toBe('typescript');
    expect(producer!['name']).toBe('@moonshot-ai/core');
    expect(typeof producer!['version']).toBe('string');
    expect(producer!['version']).toBe('0.0.0-unset');
  });

  it('setProducerInfo({ version }) flows into producer.version on the header', async () => {
    setProducerInfo({ version: '0.5.0' });

    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      protocolVersion: '2.1',
      now: () => 1712790000000,
    });

    await writer.append({ type: 'user_message', turn_id: 't1', content: 'hi' });
    await writer.flush();

    const header = await readFirstLine(filePath);
    const producer = header['producer'] as Record<string, unknown>;
    expect(producer['version']).toBe('0.5.0');
    // kind + name should retain the defaults untouched by a partial update.
    expect(producer['kind']).toBe('typescript');
    expect(producer['name']).toBe('@moonshot-ai/core');
  });

  it('mirrors producer.version into the legacy `kimi_version` slot when no explicit kimiVersion is passed', async () => {
    // Decision: kimi_version is a deprecated compat field. When the writer
    // isn't given an explicit host version, it copies producer.version so
    // older readers (Python kimi-cli / pre-Phase-22 TS) still see a sensible
    // value. Tightly coupled to Step 3.
    setProducerInfo({ version: '0.5.0' });

    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      protocolVersion: '2.1',
      now: () => 1712790000000,
      // NOTE: no kimiVersion override — implicit path
    });

    await writer.append({ type: 'user_message', turn_id: 't1', content: 'hi' });
    await writer.flush();

    const header = await readFirstLine(filePath);
    const producer = header['producer'] as Record<string, unknown>;
    expect(producer['version']).toBe('0.5.0');
    expect(header['kimi_version']).toBe('0.5.0');
  });

  it('explicit kimiVersion option wins over producer.version for the `kimi_version` compat slot', async () => {
    // If a host cares enough to override `kimiVersion` (e.g. embedding
    // scenario where the SDK wants to stamp its OWN package version as
    // the kimi_version, distinct from the engine's producer.version),
    // the writer must respect that. producer.version is untouched.
    setProducerInfo({ version: '0.5.0' });

    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      protocolVersion: '2.1',
      kimiVersion: 'host-1.2.3',
      now: () => 1712790000000,
    });

    await writer.append({ type: 'user_message', turn_id: 't1', content: 'hi' });
    await writer.flush();

    const header = await readFirstLine(filePath);
    expect(header['kimi_version']).toBe('host-1.2.3');
    // producer.version is still producer-info-truth, not the host override.
    const producer = header['producer'] as Record<string, unknown>;
    expect(producer['version']).toBe('0.5.0');
  });

  it('happy-path shape — all three producer fields present and non-empty', async () => {
    setProducerInfo({
      kind: 'typescript',
      name: '@moonshot-ai/core',
      version: '1.0.0',
    });

    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      now: () => 2_000,
    });
    await writer.append({ type: 'user_message', turn_id: 't1', content: 'x' });
    await writer.flush();

    const header = await readFirstLine(filePath);
    expect(header['type']).toBe('metadata');
    expect(header['protocol_version']).toBe('2.1');
    const producer = header['producer'] as Record<string, unknown>;
    expect(Object.keys(producer).sort()).toEqual(['kind', 'name', 'version']);
    expect(typeof producer['kind']).toBe('string');
    expect(typeof producer['name']).toBe('string');
    expect(typeof producer['version']).toBe('string');
    expect((producer['kind'] as string).length).toBeGreaterThan(0);
    expect((producer['name'] as string).length).toBeGreaterThan(0);
    expect((producer['version'] as string).length).toBeGreaterThan(0);
  });
});
