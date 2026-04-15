// Writer for migration output. Owns the target session directory layout
// (wire.jsonl + state.json) and drives WiredJournalWriter under an
// "always active" lifecycle gate (migration is a non-runtime context, so
// no compaction / completion state machine is involved).

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { SessionState } from '../../session/state-cache.js';
import type { AppendInput, LifecycleGate } from '../../storage/journal-writer.js';
import { WiredJournalWriter } from '../../storage/journal-writer.js';

const ACTIVE_GATE: LifecycleGate = { state: 'active' };

export interface WriteResult {
  readonly wirePath: string;
  readonly statePath: string;
}

export async function writeMigratedWire(
  wirePath: string,
  records: readonly AppendInput[],
  sourceProtocolVersion: string | null,
): Promise<void> {
  await mkdir(dirname(wirePath), { recursive: true });
  const writer = new WiredJournalWriter({
    filePath: wirePath,
    lifecycle: ACTIVE_GATE,
    kimiVersion: `migrated-from-python-${sourceProtocolVersion ?? 'unknown'}`,
  });
  for (const record of records) {
    await writer.append(record);
  }
}

export interface MigratedStateInput {
  readonly sessionId: string;
  readonly now: number;
  readonly title: string | null;
  readonly autoApproveActions: readonly string[];
  readonly migratedFrom: {
    readonly workDirPath: string | null;
    readonly sourceUuid: string;
    readonly migratedAt: number;
  };
}

export async function writeMigratedState(
  statePath: string,
  input: MigratedStateInput,
): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const base: SessionState = {
    session_id: input.sessionId,
    created_at: input.now,
    updated_at: input.now,
    auto_approve_actions: [...input.autoApproveActions],
  };
  const payload = {
    ...base,
    ...(input.title !== null ? { title: input.title } : {}),
    migratedFrom: input.migratedFrom,
  };
  await writeFile(statePath, JSON.stringify(payload, null, 2), 'utf8');
}
