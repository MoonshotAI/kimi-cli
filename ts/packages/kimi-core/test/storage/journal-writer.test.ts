// Component: JournalWriter (§4.5.4)
// Covers: AsyncSerialQueue ordering, fsync semantics, LifecycleGate gating,
// seq allocation, wire.jsonl as the sole physical write site, metadata
// header bootstrap.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JournalGatedError } from '../../src/storage/errors.js';
import {
  type LifecycleGate,
  type LifecycleState,
  WiredJournalWriter,
} from '../../src/storage/journal-writer.js';

class StubGate implements LifecycleGate {
  state: LifecycleState = 'active';
}

async function readWireLines(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8');
  return text.split('\n').filter((l) => l.length > 0);
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'kimi-journal-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('WiredJournalWriter.append — basic writes', () => {
  it('writes metadata header on first append', async () => {
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      protocolVersion: '2.1',
      now: () => 1712790000000,
    });

    await writer.append({
      type: 'user_message',
      turn_id: 't1',
      content: 'hello',
    });

    const lines = await readWireLines(filePath);
    expect(lines.length).toBe(2);
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(header['type']).toBe('metadata');
    expect(header['protocol_version']).toBe('2.1');
    expect(typeof header['created_at']).toBe('number');
  });

  it('stamps monotonic seq and write-time on each record', async () => {
    const filePath = join(workDir, 'wire.jsonl');
    let clock = 1000;
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      now: () => clock++,
    });

    const a = await writer.append({
      type: 'user_message',
      turn_id: 't1',
      content: 'a',
    });
    const b = await writer.append({
      type: 'user_message',
      turn_id: 't1',
      content: 'b',
    });

    expect(a.seq + 1).toBe(b.seq);
    expect(a.time).toBeLessThan(b.time);
  });

  it('persists the exact same record that is returned', async () => {
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
    });

    const returned = await writer.append({
      type: 'assistant_message',
      turn_id: 't1',
      text: 'ok',
      think: null,
      tool_calls: [],
      model: 'moonshot-v1',
    });

    const lines = await readWireLines(filePath);
    const lastLine = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    expect(lastLine['seq']).toBe(returned.seq);
    expect(lastLine['time']).toBe(returned.time);
    expect(lastLine['type']).toBe('assistant_message');
  });
});

describe('WiredJournalWriter — serialisation', () => {
  it('processes concurrent appends in FIFO call order', async () => {
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
    });

    const all = await Promise.all([
      writer.append({ type: 'user_message', turn_id: 't1', content: '1' }),
      writer.append({ type: 'user_message', turn_id: 't1', content: '2' }),
      writer.append({ type: 'user_message', turn_id: 't1', content: '3' }),
    ]);

    // Seq must reflect the order the calls were made in, not completion order.
    expect(all.map((r) => r.seq)).toEqual([all[0].seq, all[0].seq + 1, all[0].seq + 2]);

    const lines = await readWireLines(filePath);
    // 1 metadata header + 3 records.
    expect(lines.length).toBe(4);
    const contents = lines.slice(1).map((l) => (JSON.parse(l) as { content: string }).content);
    expect(contents).toEqual(['1', '2', '3']);
  });
});

describe('WiredJournalWriter — lifecycle gate', () => {
  it('rejects appends while gate is compacting', async () => {
    const gate = new StubGate();
    const writer = new WiredJournalWriter({
      filePath: join(workDir, 'wire.jsonl'),
      lifecycle: gate,
    });

    gate.state = 'compacting';

    await expect(
      writer.append({ type: 'user_message', turn_id: 't1', content: 'blocked' }),
    ).rejects.toBeInstanceOf(JournalGatedError);
  });

  it('the rejected JournalGatedError carries the gate state and record type', async () => {
    const gate = new StubGate();
    const writer = new WiredJournalWriter({
      filePath: join(workDir, 'wire.jsonl'),
      lifecycle: gate,
    });

    gate.state = 'compacting';

    let caught: unknown;
    try {
      await writer.append({ type: 'user_message', turn_id: 't1', content: 'blocked' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(JournalGatedError);
    const err = caught as JournalGatedError;
    expect(err.state).toBe('compacting');
    expect(err.recordType).toBe('user_message');
  });

  it('resumes accepting appends after gate returns to active', async () => {
    const gate = new StubGate();
    const writer = new WiredJournalWriter({
      filePath: join(workDir, 'wire.jsonl'),
      lifecycle: gate,
    });

    gate.state = 'compacting';
    await expect(
      writer.append({ type: 'user_message', turn_id: 't1', content: 'x' }),
    ).rejects.toBeInstanceOf(JournalGatedError);

    gate.state = 'active';
    const record = await writer.append({
      type: 'user_message',
      turn_id: 't1',
      content: 'y',
    });
    expect(record.type).toBe('user_message');
  });
});

describe('WiredJournalWriter — fsync semantics', () => {
  it('does not resolve the append promise before data is readable from disk', async () => {
    // This is the canonical "did the content survive across a plain open()?"
    // assertion. We do not reach inside to observe fsync() syscalls, we
    // just verify the post-condition: a fresh read() sees the line.
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
    });

    await writer.append({
      type: 'user_message',
      turn_id: 't1',
      content: 'durable',
    });

    const text = await readFile(filePath, 'utf8');
    expect(text).toMatch(/durable/);
  });
});
