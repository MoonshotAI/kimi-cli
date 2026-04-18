/**
 * `kimi export` — Phase 21 Slice E.2.
 *
 * Drives the command through the injected `ExportDeps` so we read the
 * resulting ZIP from a tmp dir and verify manifest + file inventory.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleExport } from '../../src/cli/sub/export.js';
import type { ExportDeps } from '../../src/cli/sub/export.js';

let tmp: string;
let sessionsDir: string;
let logsDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kimi-export-'));
  sessionsDir = join(tmp, 'sessions');
  logsDir = join(tmp, 'logs');
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeDeps(overrides: Partial<ExportDeps> = {}): {
  deps: ExportDeps;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const deps: ExportDeps = {
    getVersion: () => '1.27.0',
    resolveSessionDir: (id) => join(sessionsDir, id),
    findMostRecentSession: async () => undefined,
    logsDir,
    now: () => new Date('2026-04-18T12:00:00Z'),
    cwd: () => tmp,
    stdout: {
      write: (chunk: string) => {
        stdout.push(chunk);
        return true;
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderr.push(chunk);
        return true;
      },
    },
    exit: ((code: number) => {
      exitCodes.push(code);
      throw new ExitCalled(code);
    }) as ExportDeps['exit'],
    ...overrides,
  };
  return { deps, stdout, stderr, exitCodes };
}

class ExitCalled extends Error {
  constructor(public readonly code: number) {
    super(`exit(${code})`);
  }
}

async function runExport(
  deps: ExportDeps,
  args: { sessionId?: string; output?: string } = {},
): Promise<void> {
  try {
    await handleExport(deps, args.sessionId, args.output);
  } catch (err) {
    if (err instanceof ExitCalled) return;
    throw err;
  }
}

// ─── Tiny ZIP reader (CD-based) ─────────────────────────────────────

function readZipEntries(buf: Buffer): Map<string, Buffer> {
  // Walk back through the last 64KiB looking for the End-Of-Central-Directory record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('zip eocd not found');
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const entries = new Map<string, Buffer>();
  let pos = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error(`bad central-directory entry at ${String(pos)}`);
    }
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const fnameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const lfhOffset = buf.readUInt32LE(pos + 42);
    const filename = buf.toString('utf8', pos + 46, pos + 46 + fnameLen);

    // Local file header:   sig(4) + ... + fnameLen(26..28) + extraLen(28..30)
    if (buf.readUInt32LE(lfhOffset) !== 0x04034b50) {
      throw new Error(`bad local-file-header at ${String(lfhOffset)}`);
    }
    const lfhFnameLen = buf.readUInt16LE(lfhOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(lfhOffset + 28);
    const dataStart = lfhOffset + 30 + lfhFnameLen + lfhExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);
    const data =
      method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed) : null;
    if (data === null) throw new Error(`unsupported compression method: ${String(method)}`);
    entries.set(filename, data);
    pos += 46 + fnameLen + extraLen + commentLen;
  }
  return entries;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('kimi export', () => {
  it('writes a zip with manifest + every session file', async () => {
    const sid = 'ses_test123456';
    const sessionDir = join(sessionsDir, sid);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'wire.jsonl'), '{"t":"begin"}\n', 'utf-8');
    writeFileSync(
      join(sessionDir, 'state.json'),
      JSON.stringify({ session_id: sid }),
      'utf-8',
    );
    mkdirSync(join(sessionDir, 'subagents'), { recursive: true });
    writeFileSync(join(sessionDir, 'subagents', 'a.txt'), 'child', 'utf-8');

    const output = join(tmp, 'out.zip');
    const { deps, stdout, stderr, exitCodes } = makeDeps();
    await runExport(deps, { sessionId: sid, output });
    expect(exitCodes).toEqual([]);
    expect(stdout.join('').trim()).toBe(output);
    // No logs written → should not print the sensitive-info warning.
    expect(stderr.join('').toLowerCase()).not.toContain('sensitive');

    const zipBuf = readFileSync(output);
    const entries = readZipEntries(zipBuf);
    expect(entries.has('manifest.json')).toBe(true);
    expect(entries.has('wire.jsonl')).toBe(true);
    expect(entries.has('state.json')).toBe(true);
    expect(entries.has('subagents/a.txt')).toBe(true);

    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf-8')) as {
      session_id: string;
      exported_at: string;
      kimi_cli_version: string;
      wire_protocol_version: string;
    };
    expect(manifest.session_id).toBe(sid);
    expect(manifest.exported_at).toBe('2026-04-18T12:00:00.000Z');
    expect(manifest.kimi_cli_version).toBe('1.27.0');
    expect(manifest.wire_protocol_version).toMatch(/^\d+\.\d+$/);
  });

  it('bundles recent diagnostic logs and warns on stderr', async () => {
    const sid = 'ses_withlog';
    const sessionDir = join(sessionsDir, sid);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'wire.jsonl'), 'x', 'utf-8');
    // Recent log (within 2-day window) → included.
    const recentLog = join(logsDir, 'kimi.2026-04-18_11-00-00_aaa.log');
    writeFileSync(recentLog, 'LOG LINE', 'utf-8');
    // Stale log (modified 10 days before `now`) → excluded.
    const staleLog = join(logsDir, 'kimi.2026-04-08_11-00-00_aaa.log');
    writeFileSync(staleLog, 'STALE', 'utf-8');
    const tenDaysAgo = new Date('2026-04-08T11:00:00Z');
    const staleMs = tenDaysAgo.getTime() / 1000;
    // Update mtime so the freshness filter picks the recent file only.
    const { utimesSync } = await import('node:fs');
    utimesSync(staleLog, staleMs, staleMs);

    const output = join(tmp, 'out2.zip');
    const { deps, stderr } = makeDeps();
    await runExport(deps, { sessionId: sid, output });

    const entries = readZipEntries(readFileSync(output));
    expect(entries.has('logs/kimi.2026-04-18_11-00-00_aaa.log')).toBe(true);
    expect(entries.has('logs/kimi.2026-04-08_11-00-00_aaa.log')).toBe(false);
    expect(stderr.join('').toLowerCase()).toContain('diagnostic logs');
  });

  it('exits 1 when no session-id is provided and no previous session exists', async () => {
    const { deps, stderr, exitCodes } = makeDeps({
      findMostRecentSession: async () => undefined,
    });
    await runExport(deps);
    expect(exitCodes).toContain(1);
    expect(stderr.join('').toLowerCase()).toContain('no previous session');
  });

  it('exits 1 when the named session is missing on disk', async () => {
    const { deps, stderr, exitCodes } = makeDeps();
    await runExport(deps, { sessionId: 'ses_does_not_exist' });
    expect(exitCodes).toContain(1);
    expect(stderr.join('').toLowerCase()).toContain('not found');
  });

  it('falls back to the most-recent session when no id is supplied', async () => {
    const sid = 'ses_fallback';
    const sessionDir = join(sessionsDir, sid);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'wire.jsonl'), 'xy', 'utf-8');

    const output = join(tmp, 'fallback.zip');
    const { deps, stdout, exitCodes } = makeDeps({
      findMostRecentSession: async () => sid,
    });
    await runExport(deps, { output });
    expect(exitCodes).toEqual([]);
    expect(stdout.join('').trim()).toBe(output);
    const entries = readZipEntries(readFileSync(output));
    expect(entries.has('wire.jsonl')).toBe(true);
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf-8')) as {
      session_id: string;
    };
    expect(manifest.session_id).toBe(sid);
  });
});
