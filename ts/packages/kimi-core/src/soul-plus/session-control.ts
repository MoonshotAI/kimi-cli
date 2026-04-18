/**
 * SessionControl — session-level command handler.
 *
 * Provides the in-process contract for the four core slash commands:
 *   - `/compact` — trigger context compaction via TurnManager
 *   - `/clear`   — clear conversation history via ContextState.clear()
 *   - `/plan`    — toggle plan mode
 *   - `/yolo`    — toggle bypass-permissions mode
 *
 * SessionControl lives in SoulPlus because it touches TurnManager
 * (permission mode) and ContextState (config change projection).
 * The wire protocol routes `session.compact` / `session.clear` /
 * `session.setPlanMode` / `session.setYolo` through this handler.
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
   * prompt, model, active tools, plan mode, and permission rules.
   * Delegates to `ContextState.clear()` which writes a durable
   * `context_cleared` wire record (WAL-then-mirror).
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

  async compact(customInstruction?: string): Promise<void> {
    // Slice 5.6: pass custom instruction through to TurnManager so it
    // reaches the CompactionProvider (e.g. "keep database discussions").
    await this.turnManager.triggerCompaction(customInstruction);
  }

  async clear(): Promise<void> {
    // Slice 20-A — delegates to ContextState.clear(). The WAL append
    // (context_cleared) happens inside ContextState; SessionControl does
    // NOT emit an EventSink event (铁律 4 双通道 — clear is not a
    // derived-field bus event), and must not touch plan_mode /
    // permission_mode (those are owned by separate handlers).
    await this.contextState.clear();
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
