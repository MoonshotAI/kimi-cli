// Tolerant readers for Python session files. Each reader treats malformed
// lines as warnings (matching Python's own permissive parsers in
// `wire/file.py` / `soul/context.py`) and never throws on individual lines —
// only on "file is missing / unreadable at the OS level" cases.

import { access, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  PythonContextEntry,
  PythonSessionState,
  PythonWireMetadata,
  PythonWireRecord,
} from './types.js';

export interface ReadPythonContextResult {
  readonly entries: readonly PythonContextEntry[];
  readonly warnings: readonly string[];
}

export interface ReadPythonWireResult {
  readonly metadata: PythonWireMetadata | null;
  readonly records: readonly PythonWireRecord[];
  readonly warnings: readonly string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function* iterJsonLines(raw: string): IterableIterator<{ lineNo: number; text: string }> {
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i] ?? '';
    if (text.trim().length === 0) {
      continue;
    }
    yield { lineNo: i + 1, text };
  }
}

/**
 * Read Python `context.jsonl`. Returns the (possibly empty) ordered list of
 * entries plus warnings. If the file does not exist, returns an empty list
 * — same semantics as the Python reader which treats missing as empty.
 */
export async function readPythonContext(path: string): Promise<ReadPythonContextResult> {
  const warnings: string[] = [];
  if (!(await exists(path))) {
    return { entries: [], warnings };
  }
  const raw = await readFile(path, 'utf8');
  const entries: PythonContextEntry[] = [];
  for (const { lineNo, text } of iterJsonLines(raw)) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && 'role' in parsed) {
        entries.push(parsed as PythonContextEntry);
      } else {
        warnings.push(`context.jsonl line ${lineNo}: missing role field, skipping`);
      }
    } catch (error) {
      warnings.push(`context.jsonl line ${lineNo}: invalid JSON, skipping (${String(error)})`);
    }
  }
  return { entries, warnings };
}

/**
 * Read Python `wire.jsonl`. The first non-empty line is the metadata header
 * (legacy files may omit it; in that case we fall back to protocol_version
 * '1.1'). Body records are `{timestamp, message:{type,payload}}`.
 */
export async function readPythonWire(path: string): Promise<ReadPythonWireResult> {
  const warnings: string[] = [];
  if (!(await exists(path))) {
    return { metadata: null, records: [], warnings };
  }
  const raw = await readFile(path, 'utf8');
  let metadata: PythonWireMetadata | null = null;
  const records: PythonWireRecord[] = [];

  for (const { lineNo, text } of iterJsonLines(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      warnings.push(`wire.jsonl line ${lineNo}: invalid JSON, skipping (${String(error)})`);
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') {
      warnings.push(`wire.jsonl line ${lineNo}: not an object, skipping`);
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    if (obj['type'] === 'metadata' && typeof obj['protocol_version'] === 'string') {
      metadata = { type: 'metadata', protocol_version: obj['protocol_version'] };
      continue;
    }
    if (
      typeof obj['timestamp'] === 'number' &&
      obj['message'] !== null &&
      typeof obj['message'] === 'object'
    ) {
      const envelope = obj['message'] as Record<string, unknown>;
      if (typeof envelope['type'] === 'string') {
        records.push({
          timestamp: obj['timestamp'],
          message: {
            type: envelope['type'],
            payload:
              envelope['payload'] !== null && typeof envelope['payload'] === 'object'
                ? (envelope['payload'] as Record<string, unknown>)
                : {},
          },
        });
        continue;
      }
    }
    warnings.push(`wire.jsonl line ${lineNo}: unrecognized shape, skipping`);
  }
  return { metadata, records, warnings };
}

export async function readPythonSessionState(path: string): Promise<PythonSessionState | null> {
  if (!(await exists(path))) {
    return null;
  }
  try {
    const raw = await readFile(path, 'utf8');
    if (raw.trim().length === 0) {
      return null;
    }
    return JSON.parse(raw) as PythonSessionState;
  } catch {
    return null;
  }
}

/**
 * Resolve the Python `work_dir` path for a session by consulting
 * `~/.kimi/kimi.json` (if present). Returns `null` when the file does not
 * exist or the uuid isn't listed.
 */
export async function resolveWorkDirFromKimiJson(
  kimiJsonPath: string,
  sessionUuid: string,
): Promise<string | null> {
  if (!(await exists(kimiJsonPath))) {
    return null;
  }
  try {
    const raw = await readFile(kimiJsonPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') {
      return null;
    }
    const workDirs = (parsed as { work_dirs?: unknown }).work_dirs;
    if (!Array.isArray(workDirs)) {
      return null;
    }
    for (const entry of workDirs as unknown[]) {
      if (entry === null || typeof entry !== 'object') continue;
      const e = entry as { path?: unknown; last_session_id?: unknown };
      if (typeof e.path === 'string' && e.last_session_id === sessionUuid) {
        return e.path;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function hasSubagentsDir(sessionDir: string): Promise<boolean> {
  const subDir = join(sessionDir, 'subagents');
  try {
    const stats = await stat(subDir);
    if (!stats.isDirectory()) return false;
    const entries = await readdir(subDir);
    return entries.length > 0;
  } catch {
    return false;
  }
}
