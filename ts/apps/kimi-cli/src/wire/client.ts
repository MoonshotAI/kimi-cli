/**
 * WireClient -- the contract between the CLI/TUI and the agent core.
 *
 * Wire 2.1 design:
 *  - `prompt()` is non-blocking, returns `{ turn_id }`.
 *  - Events arrive via `subscribe()` (independent of prompt).
 *  - Core-initiated requests (approval, question, hook) are responded
 *    to via `respondToRequest()`.
 *
 * The production implementation is `KimiCoreClient` in `kimi-core-client.ts`.
 */

import type {
  ApprovalResponseData,
  InitializeParams,
  InitializeResult,
  SessionInfo,
  SessionStatusResult,
  SessionUsageResult,
} from './methods.js';
import type { WireMessage } from './wire-message.js';

// ── WireClient Interface ────────────────────────────────────────────

export interface WireClient {
  /** Handshake with Core. */
  initialize(params: InitializeParams): Promise<InitializeResult>;

  /** Create a new session. Returns the session ID. */
  createSession(workDir: string): Promise<{ session_id: string }>;
  /** List all sessions. */
  listSessions(): Promise<{ sessions: SessionInfo[] }>;
  /** Destroy a session. */
  destroySession(sessionId: string): Promise<void>;

  /** Submit user input (non-blocking). Returns the turn ID. */
  prompt(sessionId: string, input: string): Promise<{ turn_id: string }>;
  /** Inject follow-up input into the current turn. */
  steer(sessionId: string, input: string): Promise<void>;
  /** Cancel the current turn. */
  cancel(sessionId: string): Promise<void>;
  /** Resume a session from persisted state. */
  resume(sessionId: string): Promise<void>;
  /**
   * Re-open an existing on-disk session under the same id (reload
   * wire.jsonl, rebuild SoulPlus). Returns the (unchanged) session id.
   * Optional because mock/offline clients may not support it.
   */
  resumeSession?(sessionId: string): Promise<{ session_id: string }>;

  /** Fork a session. */
  fork(sessionId: string, atTurn?: number): Promise<{ session_id: string }>;
  /** Rename a session. */
  rename(sessionId: string, title: string): Promise<void>;
  /** Get session status snapshot. */
  getStatus(sessionId: string): Promise<SessionStatusResult>;
  /** Get token usage statistics. */
  getUsage(sessionId: string): Promise<SessionUsageResult>;
  /** Trigger manual compaction. Optional custom instruction for the summary. */
  compact(sessionId: string, customInstruction?: string): Promise<void>;
  /**
   * Clear the session's conversation context (history) while keeping the
   * session itself alive. Writes a `context_cleared` wire record so
   * replay reconstructs the empty-from-here-on state; preserves
   * systemPrompt / model / activeTools / permissionMode / planMode.
   */
  clear(sessionId: string): Promise<void>;

  /** Runtime model switch — superseded by `switchModel`. */
  setModel(sessionId: string, model: string): Promise<void>;
  /**
   * Rebuild the Runtime for `modelAlias` and re-open the session under
   * the same id. Returns the (unchanged) session id on success.
   */
  switchModel?(sessionId: string, modelAlias: string): Promise<{ session_id: string }>;
  /** Switch thinking level. */
  setThinking(sessionId: string, level: string): Promise<void>;
  /** Toggle plan mode. */
  setPlanMode(sessionId: string, enabled: boolean): Promise<void>;
  /** Toggle yolo mode. */
  setYolo(sessionId: string, enabled: boolean): Promise<void>;

  /** Subscribe to session events (independent of prompt). */
  subscribe(sessionId: string): AsyncIterable<WireMessage>;

  /** Respond to a Core-initiated request (approval, question, hook). */
  respondToRequest(requestId: string, data: unknown): void;

  /**
   * Dispatch a parsed slash command (e.g. `/compact`, `/plan off`) to
   * the underlying runtime. Returns a user-facing result that the TUI
   * can surface in the transcript. Implementations should never throw —
   * unexpected failures should be reported via `ok: false`.
   */
  handleSlashCommand(
    sessionId: string,
    name: string,
    args: readonly string[],
  ): Promise<SlashCommandResult>;

  /** Release resources. */
  dispose(): Promise<void>;

  /**
   * Phase 21 §D.1 — wire bridge for `session.rollback`. Rolls back the
   * latest `nTurnsBack` turns (default 1) in the persisted wire.jsonl +
   * resumes in-memory state. Returns the new total turn count. Optional
   * so mock / offline clients that never exercise /undo keep compiling.
   */
  rollback?(sessionId: string, nTurnsBack: number): Promise<{ new_turn_count: number }>;

  /**
   * Phase 21 §D.2 — wire bridge for `session.listSkills`. Returns the
   * invocable skills (same filter as `SkillManager.listInvocableSkills`).
   * Used by the slash dispatcher to fall through `/cmd` to a skill of
   * the same name when no built-in command matches.
   */
  listSkills?(sessionId: string): Promise<{
    skills: ReadonlyArray<{ name: string; description: string }>;
  }>;

  /**
   * Phase 21 §D.2 — wire bridge for `session.activateSkill`. Activates a
   * registered skill by name; the SKILL.md body is appended to the
   * session ContextState (inline-mode), no LLM turn is kicked off.
   */
  activateSkill?(sessionId: string, name: string, args: string): Promise<void>;

  /**
   * Phase 21 §D.4 — return the cached initialize response so `/hooks`
   * can surface `capabilities.hooks.configured[]`. Implementations cache
   * the result of the first `initialize()` call; callers that never
   * handshake may observe `undefined`.
   */
  getInitializeResponse?(): InitializeResult | undefined;
}

/** Result of {@link WireClient.handleSlashCommand}. */
export interface SlashCommandResult {
  readonly ok: boolean;
  readonly message: string;
  /**
   * Optional state delta the host should apply after a successful
   * command. `kimi-core` is the source of truth for `planMode` / `yolo`
   * / `thinking`, so the TUI mirrors whatever session control reports
   * back rather than guessing from the parsed arguments. Present only
   * when the command mutated host-observable state.
   */
  readonly stateUpdate?: SlashCommandStateUpdate | undefined;
}

/** State patch emitted by a slash command that mutates host state. */
export interface SlashCommandStateUpdate {
  readonly planMode?: boolean | undefined;
  readonly yolo?: boolean | undefined;
  readonly thinking?: boolean | undefined;
  readonly model?: string | undefined;
}

// ── Re-export for convenience ───────────────────────────────────────

export type { ApprovalResponseData };
