import { readFile } from 'node:fs/promises';

import { IncompatibleVersionError, WireJournalCorruptError } from './errors.js';
import type { LifecycleGate } from './journal-writer.js';
import {
  WireFileMetadataSchema,
  WireRecordSchema,
  type WireFileMetadata,
  type WireRecord,
} from './wire-record.js';

export type SessionHealth = 'ok' | 'broken';

export interface ReplayResult {
  readonly records: readonly WireRecord[];
  readonly protocolVersion: string;
  readonly health: SessionHealth;
  /** Human readable reason the session was marked broken, if applicable. */
  readonly brokenReason?: string;
  readonly warnings: readonly string[];
}

export interface ReplayOptions {
  /** Highest protocol major the caller can understand. */
  readonly supportedMajor: number;
  /** Override reader for tests — default reads from disk. */
  readonly readLines?: (path: string) => Promise<string[]>;
  readonly lifecycle?: LifecycleGate;
}

async function defaultReadLines(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8');
  // We preserve the last line even if it lacks a trailing newline — callers
  // (tail truncation tolerance) rely on seeing the partial body line.
  const parts = text.split('\n');
  if (parts.length > 0 && parts.at(-1) === '') {
    parts.pop();
  }
  return parts;
}

/**
 * Replay a wire.jsonl into an ordered list of valid WireRecords plus a
 * health signal. Does not construct a ContextState — that concern lives in
 * WiredContextState which drives its internal mirror from these records.
 *
 * Error policy (§4.1.1 / §8.4):
 *   - unknown record type at any line → skip + warn
 *   - JSON.parse failure on the LAST body line → skip + warn (tail truncation)
 *   - JSON.parse failure on any earlier line → health = 'broken'
 *   - major version higher than supportedMajor → throw IncompatibleVersionError
 */
export async function replayWire(path: string, options: ReplayOptions): Promise<ReplayResult> {
  const readLines = options.readLines ?? defaultReadLines;
  const lines = await readLines(path);

  if (lines.length === 0) {
    throw new WireJournalCorruptError(`wire.jsonl is empty at ${path}`);
  }

  // 1. Parse metadata header (first line). It is mandatory.
  const firstLine = lines[0];
  if (firstLine === undefined) {
    throw new WireJournalCorruptError(`wire.jsonl is empty at ${path}`);
  }
  let meta: WireFileMetadata;
  try {
    meta = WireFileMetadataSchema.parse(JSON.parse(firstLine));
  } catch (error) {
    throw new WireJournalCorruptError(
      `wire.jsonl metadata header (line 1) is invalid: ${String(error)}`,
    );
  }

  // 2. Version compatibility check.
  const majorStr = meta.protocol_version.split('.')[0] ?? '0';
  const major = Number.parseInt(majorStr, 10);
  if (!Number.isFinite(major)) {
    throw new IncompatibleVersionError(
      `wire.jsonl metadata.protocol_version "${meta.protocol_version}" is not a valid version string`,
    );
  }
  if (major > options.supportedMajor) {
    throw new IncompatibleVersionError(
      `wire.jsonl version ${meta.protocol_version} is not supported (max major: ${options.supportedMajor}). Please upgrade Kimi CLI.`,
    );
  }

  // 3. Replay body lines.
  const records: WireRecord[] = [];
  const warnings: string[] = [];
  const bodyLines = lines.slice(1);

  for (const [i, line] of bodyLines.entries()) {
    const physicalLineNo = i + 2;
    const isLastLine = i === bodyLines.length - 1;
    const snippet = line.slice(0, 100);

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      if (isLastLine) {
        warnings.push(`Tail line truncated at line ${physicalLineNo}, skipping: ${snippet}`);
        continue;
      }
      const reason = `wire.jsonl mid-file corruption at line ${physicalLineNo}: ${String(error)}`;
      return {
        records,
        protocolVersion: meta.protocol_version,
        health: 'broken',
        brokenReason: reason,
        warnings,
      };
    }

    // Unknown record type → skip + warn (forward compatibility).
    const typeField = (raw as { type?: unknown } | null)?.type;
    if (typeof typeField !== 'string' || !KNOWN_RECORD_TYPES.has(typeField)) {
      warnings.push(
        `Skipping unrecognized record type "${String(typeField)}" at line ${physicalLineNo}: ${snippet}`,
      );
      continue;
    }

    const parsed = WireRecordSchema.safeParse(raw);
    if (!parsed.success) {
      // A known type that fails schema validation — treat this the same way
      // as corruption on a non-tail line (session health = broken), because
      // the record shape is meant to be forward-compatible via minor version
      // bumps and any schema drift inside a known type is a real problem.
      if (isLastLine) {
        warnings.push(
          `Tail record failed schema validation at line ${physicalLineNo}, skipping: ${snippet}`,
        );
        continue;
      }
      const reason = `wire.jsonl schema violation at line ${physicalLineNo}: ${parsed.error.message}`;
      return {
        records,
        protocolVersion: meta.protocol_version,
        health: 'broken',
        brokenReason: reason,
        warnings,
      };
    }
    records.push(parsed.data);
  }

  return {
    records,
    protocolVersion: meta.protocol_version,
    health: 'ok',
    warnings,
  };
}

const KNOWN_RECORD_TYPES: ReadonlySet<string> = new Set([
  'turn_begin',
  'turn_end',
  'user_message',
  'assistant_message',
  'tool_result',
  'compaction',
  'system_prompt_changed',
  'model_changed',
  'thinking_changed',
  'plan_mode_changed',
  'tools_changed',
  'system_reminder',
  'notification',
  'permission_mode_changed',
  'tool_call_dispatched',
  'tool_denied',
  'skill_invoked',
  'skill_completed',
  'approval_request',
  'approval_response',
  'team_mail',
  // Phase 6 (决策 #88): the legacy `subagent_event` envelope is gone.
  // Each subagent persists its own wire.jsonl; the parent wire only
  // carries these three lifecycle references. A pre-Phase-6 session that
  // still contains a `subagent_event` row falls into the "unknown record
  // type" branch below — replay skips it with a warning rather than
  // marking the session broken.
  'subagent_spawned',
  'subagent_completed',
  'subagent_failed',
  'ownership_changed',
  'context_edit',
]);
