// Writer for migration output. Owns the target session directory layout
// (wire.jsonl + state.json) and drives WiredJournalWriter under an
// "always active" lifecycle gate (migration is a non-runtime context, so
// no compaction / completion state machine is involved).

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { SessionState } from '../../session/state-cache.js';
import type { AppendInput, LifecycleGate } from '../../storage/journal-writer.js';
import { WiredJournalWriter } from '../../storage/journal-writer.js';
import type { SessionInitializedMainRecord } from '../../storage/wire-record.js';

const ACTIVE_GATE: LifecycleGate = { state: 'active' };

export interface WriteResult {
  readonly wirePath: string;
  readonly statePath: string;
}

export interface MigratedWireInit {
  readonly sessionId: string;
  readonly systemPrompt: string;
  readonly model: string;
  readonly workspaceDir: string;
}

export async function writeMigratedWire(
  wirePath: string,
  records: readonly AppendInput[],
  sourceProtocolVersion: string | null,
  init: MigratedWireInit,
): Promise<void> {
  await mkdir(dirname(wirePath), { recursive: true });
  const writer = new WiredJournalWriter({
    filePath: wirePath,
    lifecycle: ACTIVE_GATE,
    kimiVersion: `migrated-from-python-${sourceProtocolVersion ?? 'unknown'}`,
  });
  // Phase 23 — session_initialized must be wire.jsonl line 2 (right after
  // the metadata header). Migration writes an ACTIVE baseline so replay
  // can derive startup config without falling back to caller hints.
  const mainInit: Omit<SessionInitializedMainRecord, 'seq' | 'time'> = {
    type: 'session_initialized',
    agent_type: 'main',
    session_id: init.sessionId,
    system_prompt: init.systemPrompt,
    model: init.model,
    active_tools: [],
    permission_mode: 'default',
    plan_mode: false,
    workspace_dir: init.workspaceDir,
  };
  await writer.append(mainInit);
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
