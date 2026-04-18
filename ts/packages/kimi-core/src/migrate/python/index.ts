// Public API: migratePythonSession — one-shot, library-only (§Q2).
//
// Flow:
//   1. Resolve source `<session_uuid>` from the source directory basename.
//   2. Read context.jsonl / wire.jsonl / state.json (tolerant).
//   3. Build lookup tables over wire.jsonl for tool is_error, usage and
//      turn boundaries.
//   4. Walk context.jsonl to produce an ordered `AppendInput[]`.
//   5. Write wire.jsonl via `WiredJournalWriter` and state.json.
//   6. Call `replayWire` against the target file to verify the output
//      is readable with `health='ok'`.

import { basename, join } from 'node:path';

import { replayWire } from '../../storage/replay.js';
import { indexWireRecords, mapPythonToTsRecords } from './mapper.js';
import {
  hasSubagentsDir,
  readPythonContext,
  readPythonSessionState,
  readPythonWire,
  resolveWorkDirFromKimiJson,
} from './reader.js';
import { writeMigratedState, writeMigratedWire } from './writer.js';

export class MigrationError extends Error {
  readonly reason: unknown;
  constructor(message: string, reason?: unknown) {
    super(message);
    this.name = 'MigrationError';
    this.reason = reason;
  }
}

export interface MigratePythonSessionOptions {
  readonly sourceDir: string;
  readonly targetDir: string;
  readonly toolNameMap?: Readonly<Record<string, string>> | undefined;
  readonly onWarning?: ((msg: string) => void) | undefined;
  readonly migratedFrom?: { readonly workDirPath?: string | undefined } | undefined;
  /** Override for the source kimi.json lookup (defaults to `<sourceDir>/../../../kimi.json`). */
  readonly kimiJsonPath?: string | undefined;
  /** Clock override for tests. */
  readonly now?: (() => number) | undefined;
  /** Override the major version the replay verifier will accept (default 2). */
  readonly supportedWireMajor?: number | undefined;
  /** Model name to stamp on assistant_message records when Python didn't record one. */
  readonly fallbackModel?: string | undefined;
}

export interface MigrationResult {
  readonly sessionId: string;
  readonly sourceDir: string;
  readonly targetDir: string;
  readonly messageCount: number;
  readonly warnings: readonly string[];
  readonly droppedContentCount: number;
}

function emit(onWarning: ((msg: string) => void) | undefined, bag: string[], msg: string): void {
  bag.push(msg);
  if (onWarning !== undefined) onWarning(msg);
}

export async function migratePythonSession(
  options: MigratePythonSessionOptions,
): Promise<MigrationResult> {
  const sessionId = basename(options.sourceDir.replace(/\/+$/, ''));
  if (sessionId.length === 0) {
    throw new MigrationError(
      `Cannot derive session id from source directory "${options.sourceDir}"`,
    );
  }

  const warnings: string[] = [];
  const report = (msg: string): void => {
    emit(options.onWarning, warnings, msg);
  };

  const contextPath = join(options.sourceDir, 'context.jsonl');
  const wirePath = join(options.sourceDir, 'wire.jsonl');
  const statePath = join(options.sourceDir, 'state.json');

  const [contextResult, wireResult, state] = await Promise.all([
    readPythonContext(contextPath),
    readPythonWire(wirePath),
    readPythonSessionState(statePath),
  ]);
  for (const w of contextResult.warnings) report(w);
  for (const w of wireResult.warnings) report(w);

  if (contextResult.entries.length === 0 && wireResult.records.length === 0) {
    report('Source session has no context.jsonl / wire.jsonl records — nothing to migrate');
  }

  const subagentsPresent = await hasSubagentsDir(options.sourceDir);
  if (subagentsPresent) {
    report('Subagent sub-sessions not migrated, handle separately');
  }

  const wireLookups = indexWireRecords(wireResult.records);
  const mapped = mapPythonToTsRecords(contextResult.entries, wireLookups, state, {
    toolNameMap: options.toolNameMap,
    fallbackModel: options.fallbackModel,
  });
  for (const w of mapped.warnings) report(w);

  // Resolve work_dir: explicit option → kimi.json lookup → throw. Phase 23
  // (Review N3) requires the baseline to carry a real workspace_dir — the
  // previous `'/'` fallback masked misconfigured callers and the migrated
  // session would then resume against a bogus workspace. If neither source
  // surfaces a path we fail loudly so the caller must decide.
  let workDirPath: string | null = null;
  if (options.migratedFrom?.workDirPath !== undefined) {
    workDirPath = options.migratedFrom.workDirPath;
  } else {
    // kimi.json default location: source is `<home>/sessions/<md5>/<uuid>/`,
    // so kimi.json lives three levels up.
    const defaultKimiJson =
      options.kimiJsonPath ??
      join(options.sourceDir.replace(/\/+$/, ''), '..', '..', '..', 'kimi.json');
    workDirPath = await resolveWorkDirFromKimiJson(defaultKimiJson, sessionId);
  }
  if (workDirPath === null || workDirPath.length === 0) {
    throw new MigrationError(
      `Cannot migrate session "${sessionId}": workspace_dir is unresolved. ` +
        `Pass \`migratedFrom.workDirPath\` explicitly, or ensure kimi.json ` +
        `has a work_dirs entry with last_session_id="${sessionId}".`,
    );
  }

  const now = (options.now ?? Date.now)();
  const targetWirePath = join(options.targetDir, 'wire.jsonl');
  const targetStatePath = join(options.targetDir, 'state.json');

  // Extract the initial system prompt (if any) from mapped records so
  // the session_initialized baseline carries it. The first
  // `system_prompt_changed` record (if any) is the project's bootstrap
  // prompt emitted from context.jsonl's `_system_prompt` row.
  const firstSystemPromptRecord = mapped.records.find(
    (r): r is { type: 'system_prompt_changed'; new_prompt: string } =>
      r.type === 'system_prompt_changed',
  );
  const initialSystemPrompt = firstSystemPromptRecord?.new_prompt ?? '';
  // Phase 23 (Review N3) — mirror mapper.ts's fallback chain so the
  // baseline `session_initialized.model` and the mapper's inline model
  // stamps agree: options.fallbackModel > state.plan_slug > 'unknown'.
  const baselineModel = options.fallbackModel ?? state?.plan_slug ?? 'unknown';

  try {
    await writeMigratedWire(
      targetWirePath,
      mapped.records,
      wireResult.metadata?.protocol_version ?? null,
      {
        sessionId,
        systemPrompt: initialSystemPrompt,
        model: baselineModel,
        workspaceDir: workDirPath,
      },
    );
    await writeMigratedState(targetStatePath, {
      sessionId,
      now,
      title: mapped.finalTitle,
      autoApproveActions: mapped.autoApproveActions,
      migratedFrom: {
        workDirPath,
        sourceUuid: sessionId,
        migratedAt: now,
      },
    });
  } catch (error) {
    throw new MigrationError(`Failed to write migrated session to ${options.targetDir}`, error);
  }

  // Phase 23 (Review N4) — verify the migrated wire is replay-ready
  // unconditionally. Previously this was gated on `mapped.records.length
  // > 0`, but the baseline (metadata + session_initialized) itself can
  // regress (e.g. bad workspace_dir, malformed producer stamp) and we
  // want those caught here instead of the first resume.
  const replay = await replayWire(targetWirePath, {
    supportedMajor: options.supportedWireMajor ?? 2,
  });
  if (replay.health !== 'ok') {
    throw new MigrationError(
      `Migrated wire.jsonl failed post-write replay: ${replay.brokenReason ?? 'unknown'}`,
    );
  }
  for (const w of replay.warnings) report(w);

  return {
    sessionId,
    sourceDir: options.sourceDir,
    targetDir: options.targetDir,
    messageCount: mapped.messageCount,
    warnings,
    droppedContentCount: mapped.droppedContentCount,
  };
}
