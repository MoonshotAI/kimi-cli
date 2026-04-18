/**
 * Phase 22 — producer-info module (T1).
 *
 * Module-level singleton that carries the wire producer identity (kind /
 * name / version) written into every wire.jsonl metadata header.
 *
 * Covered behaviours:
 *   - T1.1  getProducerInfo() returns DEFAULT_PRODUCER before any setter call
 *   - T1.2  setProducerInfo({ version }) merges on top (other fields retained)
 *   - T1.3  _resetProducerInfoForTest() restores DEFAULT_PRODUCER
 *   - T1.4  partial update with only `name` retains kind/version
 *
 * Expectations:
 *   - DEFAULT_PRODUCER = { kind: 'typescript', name: '@moonshot-ai/core',
 *     version: '0.0.0-unset' }
 *   - `setProducerInfo(Partial<WireProducer>)` merge-updates
 *   - `getProducerInfo()` returns a copy (mutations don't leak back)
 *
 * Red bar until `src/storage/producer-info.ts` lands.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetProducerInfoForTest,
  getProducerInfo,
  setProducerInfo,
} from '../../src/storage/producer-info.js';

beforeEach(() => {
  _resetProducerInfoForTest();
});

afterEach(() => {
  _resetProducerInfoForTest();
});

describe('producer-info (T1) — default value', () => {
  it('getProducerInfo() returns DEFAULT_PRODUCER when no setter has been called', () => {
    const info = getProducerInfo();
    expect(info.kind).toBe('typescript');
    expect(info.name).toBe('@moonshot-ai/core');
    expect(info.version).toBe('0.0.0-unset');
  });

  it('getProducerInfo() returns a fresh object each call (no shared reference leak)', () => {
    const a = getProducerInfo();
    const b = getProducerInfo();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('mutating the returned object does not leak into the next read', () => {
    const info = getProducerInfo();
    // TS will type-check against `WireProducer`; we mutate via `any` to
    // simulate an out-of-process caller that treats the return as its own.
    (info as unknown as { version: string }).version = 'mutated';
    expect(getProducerInfo().version).toBe('0.0.0-unset');
  });
});

describe('producer-info (T1) — setProducerInfo merge semantics', () => {
  it('setProducerInfo({ version }) updates version, retains kind/name', () => {
    setProducerInfo({ version: '0.5.0' });
    const info = getProducerInfo();
    expect(info.version).toBe('0.5.0');
    expect(info.kind).toBe('typescript');
    expect(info.name).toBe('@moonshot-ai/core');
  });

  it('setProducerInfo({ name }) updates name, retains kind/version', () => {
    setProducerInfo({ name: 'custom-host' });
    const info = getProducerInfo();
    expect(info.name).toBe('custom-host');
    expect(info.kind).toBe('typescript');
    expect(info.version).toBe('0.0.0-unset');
  });

  it('setProducerInfo accumulates across multiple calls', () => {
    setProducerInfo({ version: '0.5.0' });
    setProducerInfo({ name: 'custom' });
    const info = getProducerInfo();
    expect(info.version).toBe('0.5.0');
    expect(info.name).toBe('custom');
    expect(info.kind).toBe('typescript');
  });

  it('full replace: passing all three fields updates all', () => {
    setProducerInfo({
      kind: 'typescript',
      name: 'test-name',
      version: '1.2.3',
    });
    expect(getProducerInfo()).toEqual({
      kind: 'typescript',
      name: 'test-name',
      version: '1.2.3',
    });
  });
});

describe('producer-info (T1) — _resetProducerInfoForTest', () => {
  it('restores DEFAULT_PRODUCER after arbitrary setProducerInfo mutation', () => {
    setProducerInfo({ version: '9.9.9', name: 'mutated' });
    _resetProducerInfoForTest();
    const info = getProducerInfo();
    expect(info.kind).toBe('typescript');
    expect(info.name).toBe('@moonshot-ai/core');
    expect(info.version).toBe('0.0.0-unset');
  });
});
