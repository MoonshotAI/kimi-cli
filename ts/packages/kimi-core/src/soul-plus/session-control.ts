/**
 * SessionControl — session-level command handler (Slice 3.2).
 *
 * Provides the in-process contract for the four core slash commands:
 *   - `/compact` — trigger context compaction (stub → Slice 3.3)
 *   - `/clear`   — clear session context (stub → needs ContextState.clear())
 *   - `/plan`    — toggle plan mode
 *   - `/yolo`    — toggle bypass-permissions mode
 *
 * SessionControl lives in SoulPlus because it touches TurnManager
 * (permission mode) and ContextState (config change projection).
 * The wire protocol routes `session.compact` / `session.setPlanMode` /
 * `session.setYolo` through this handler.
 */

import type { FullContextState } from '../storage/context-state.js';
import type { SessionJournal } from '../storage/session-journal.js';
import type { TurnManager } from './turn-manager.js';

// ── Interface ────────────────────────────────────────────────────────

export interface SessionControlHandler {
  /**
   * Trigger context compaction. Stub in Slice 3.2 — real implementation
   * lands in Slice 3.3 when the compaction pipeline is wired.
   */
  compact(customInstruction?: string): Promise<void>;

  /**
   * Clear the session context (history) while preserving the system
   * prompt and permission rules. Stub in Slice 3.2 — requires a
   * `ContextState.clear()` method that does not yet exist.
   */
  clear(): Promise<void>;

  /**
   * Toggle or set plan mode. Persists a `plan_mode_changed` record
   * via `ContextState.applyConfigChange`.
   */
  setPlanMode(enabled: boolean): Promise<void>;

  /**
   * Toggle or set yolo (bypass-permissions) mode. Updates the
   * TurnManager's permission mode and persists a
   * `permission_mode_changed` journal record.
   */
  setYolo(enabled: boolean): Promise<void>;
}

// ── Deps ─────────────────────────────────────────────────────────────

export interface SessionControlDeps {
  readonly turnManager: TurnManager;
  readonly contextState: FullContextState;
  readonly sessionJournal: SessionJournal;
}

// ── Implementation ───────────────────────────────────────────────────

export class DefaultSessionControl implements SessionControlHandler {
  private readonly turnManager: TurnManager;
  private readonly contextState: FullContextState;
  private readonly sessionJournal: SessionJournal;

  constructor(deps: SessionControlDeps) {
    this.turnManager = deps.turnManager;
    this.contextState = deps.contextState;
    this.sessionJournal = deps.sessionJournal;
  }

  async compact(_customInstruction?: string): Promise<void> {
    // Slice 3.3: delegate to TurnManager.triggerCompaction() which
    // handles the lifecycle dance (idle → active → compacting → active
    // → completing → idle) and runs the full compaction pipeline.
    await this.turnManager.triggerCompaction();
  }

  async clear(): Promise<void> {
    // Stub — requires ContextState.clear() method which does not exist
    // in Phase 1/2 ContextState. The method needs to:
    //   1. Write a context_edit{operation:'rewind'} record to the journal
    //   2. Clear the in-memory history
    //   3. Preserve system prompt / model / active tools
    // Callers should catch this and surface a user-friendly message.
    throw new Error('Context clear not yet implemented (requires ContextState.clear())');
  }

  async setPlanMode(enabled: boolean): Promise<void> {
    // ContextState.applyConfigChange handles both:
    //   1. WAL persistence (plan_mode_changed record via JournalWriter)
    //   2. In-memory projection update
    await this.contextState.applyConfigChange({
      type: 'plan_mode_changed',
      enabled,
    });
    // Slice 3.6 — also fan-out to TurnManager so the
    // DynamicInjectionManager's next InjectionContext sees the new
    // plan-mode flag. Ordering: WAL append first (for durability), then
    // in-memory mirror. If the WAL append throws, TurnManager's flag is
    // NOT flipped — matches the WAL-then-mirror invariant.
    this.turnManager.setPlanMode(enabled);
  }

  async setYolo(enabled: boolean): Promise<void> {
    const previousMode = this.turnManager.getPermissionMode();
    const newMode = enabled ? 'bypassPermissions' : 'default';

    // No-op if already in the target mode
    if (previousMode === newMode) return;

    // 1. Update TurnManager's live permission mode — takes effect on
    //    the next tool call within the current turn or the next turn.
    this.turnManager.setPermissionMode(newMode);

    // 2. Persist the change to the session journal so it survives
    //    crash recovery / session resume.
    await this.sessionJournal.appendPermissionModeChanged({
      type: 'permission_mode_changed',
      data: {
        from: previousMode,
        to: newMode,
        reason: enabled ? '/yolo on' : '/yolo off',
      },
    });
  }
}
