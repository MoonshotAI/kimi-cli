// Component: replayWire (§4.1.1)
// Covers: metadata header parsing, version compatibility, unknown record
// type skip + warn, tail truncation tolerance, mid-file corruption →
// broken health mark.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IncompatibleVersionError } from '../../src/storage/errors.js';
import { replayWire } from '../../src/storage/replay.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'kimi-replay-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeWire(lines: string[]): Promise<string> {
  const path = join(workDir, 'wire.jsonl');
  await writeFile(path, lines.map((l) => l + '\n').join(''), 'utf8');
  return path;
}

function metadata(version = '2.1'): string {
  return JSON.stringify({
    type: 'metadata',
    protocol_version: version,
    created_at: 1712790000000,
    kimi_version: '1.0.0',
    producer: { kind: 'typescript', name: '@moonshot-ai/core', version: '1.0.0' },
  });
}

function sessionInitialized(): string {
  return JSON.stringify({
    type: 'session_initialized',
    seq: 0,
    time: 1712790000001,
    agent_type: 'main',
    session_id: 'ses_test',
    system_prompt: '',
    model: 'moonshot-v1',
    active_tools: [],
    permission_mode: 'default',
    plan_mode: false,
    workspace_dir: '/tmp/ws',
  });
}

describe('replayWire — canonical happy path', () => {
  it('parses a metadata header + a handful of records', async () => {
    const path = await writeWire([
      metadata(),
      sessionInitialized(),
      JSON.stringify({
        type: 'user_message',
        seq: 1,
        time: 1712790000001,
        turn_id: 't1',
        content: 'hi',
      }),
      JSON.stringify({
        type: 'assistant_message',
        seq: 2,
        time: 1712790000002,
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
    expect(result.records[0]?.type).toBe('user_message');
    expect(result.protocolVersion).toBe('2.1');
  });
});

describe('replayWire — version compatibility', () => {
  it('throws IncompatibleVersionError when major is higher than supported', async () => {
    const path = await writeWire([metadata('3.0')]);
    await expect(replayWire(path, { supportedMajor: 2 })).rejects.toBeInstanceOf(
      IncompatibleVersionError,
    );
  });

  it('accepts a minor bump forward under the same major', async () => {
    const path = await writeWire([
      metadata('2.2'),
      sessionInitialized(),
      JSON.stringify({
        type: 'user_message',
        seq: 1,
        time: 1,
        turn_id: 't1',
        content: 'hi',
      }),
    ]);
    const result = await replayWire(path, { supportedMajor: 2 });
    expect(result.health).toBe('ok');
    expect(result.records.length).toBe(1);
  });
});

describe('replayWire — unknown record type (forward compatibility)', () => {
  it('skips unknown record types at any line and warns', async () => {
    const path = await writeWire([
      metadata(),
      sessionInitialized(),
      JSON.stringify({
        type: 'user_message',
        seq: 1,
        time: 1,
        turn_id: 't1',
        content: 'hi',
      }),
      JSON.stringify({
        type: 'future_record_from_a_newer_version',
        seq: 2,
        time: 2,
        whatever: true,
      }),
      JSON.stringify({
        type: 'assistant_message',
        seq: 3,
        time: 3,
        turn_id: 't1',
        text: 'ok',
        think: null,
        tool_calls: [],
        model: 'moonshot-v1',
      }),
    ]);

    const result = await replayWire(path, { supportedMajor: 2 });
    expect(result.health).toBe('ok');
    expect(result.records.length).toBe(2);
    expect(result.records.map((r) => r.type)).toEqual(['user_message', 'assistant_message']);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.join('\n')).toMatch(/unknown|unrecognized|future_record/i);
  });
});

describe('replayWire — tail truncation tolerance', () => {
  it('skips a partial last line (crash while writing \\n)', async () => {
    const path = join(workDir, 'wire.jsonl');
    const good = [
      metadata(),
      sessionInitialized(),
      JSON.stringify({
        type: 'user_message',
        seq: 1,
        time: 1,
        turn_id: 't1',
        content: 'hi',
      }),
    ];
    // The last line has no trailing newline and is a broken json fragment.
    await writeFile(path, good.map((l) => l + '\n').join('') + '{"type":"assistant_messa', 'utf8');

    const result = await replayWire(path, { supportedMajor: 2 });
    expect(result.health).toBe('ok');
    expect(result.records.length).toBe(1);
    expect(result.warnings.some((w) => /truncat|tail/i.test(w))).toBe(true);
  });
});

describe('replayWire — mid-file corruption', () => {
  it('marks the session broken when an earlier line fails to parse', async () => {
    const path = join(workDir, 'wire.jsonl');
    await writeFile(
      path,
      [
        metadata(),
        sessionInitialized(),
        JSON.stringify({
          type: 'user_message',
          seq: 1,
          time: 1,
          turn_id: 't1',
          content: 'hi',
        }),
        '{"type":"user_message","se',
        JSON.stringify({
          type: 'user_message',
          seq: 3,
          time: 3,
          turn_id: 't1',
          content: 'after corruption',
        }),
      ]
        .map((l) => l + '\n')
        .join(''),
      'utf8',
    );

    const result = await replayWire(path, { supportedMajor: 2 });
    expect(result.health).toBe('broken');
    expect(result.brokenReason).toBeDefined();
  });
});
