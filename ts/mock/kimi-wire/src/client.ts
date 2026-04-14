/**
 * WireClient interface -- the contract between the CLI/TUI and the agent core.
 *
 * The CLI consumes events via `AsyncIterable<WireEvent>`, sends commands
 * via imperative methods. Mock and real implementations both satisfy this
 * interface so the UI layer is transport-agnostic.
 */

import type { WireEvent } from './types.js';

// ── Client Options ────────────────────────────────────────────────────

export interface WireClientOptions {
  sessionId: string;
  workDir: string;
  model: string;
  yolo: boolean;
}

// ── Session Info ──────────────────────────────────────────────────────

export interface SessionInfo {
  id: string;
  workDir: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

// ── Approval Payload ──────────────────────────────────────────────────

export interface ApprovalResponsePayload {
  decision: 'approve' | 'approve_for_session' | 'reject';
  feedback?: string | undefined;
}

// ── WireClient Interface ──────────────────────────────────────────────

export interface WireClient {
  /** Send a user prompt and receive the resulting event stream. */
  prompt(input: string, images?: string[]): AsyncIterable<WireEvent>;

  /** Inject follow-up input into the current running turn. */
  steer(input: string): void;

  /** Cancel the current running turn. */
  cancel(): void;

  /** Reply to an approval request. */
  approvalResponse(requestId: string, response: ApprovalResponsePayload): void;

  /** Reply to a question request. */
  questionResponse(requestId: string, answer: string): void;

  /** Toggle plan mode (read-only). */
  setPlanMode(enabled: boolean): void;

  /** Replay recent history events. */
  replay(): AsyncIterable<WireEvent>;

  /** Close the connection and release resources. */
  dispose(): Promise<void>;

  // ── Session Management ────────────────────────────────────────────

  /** Create a new session, returning its ID. */
  createSession(workDir: string): Promise<string>;

  /** List sessions for a given work directory. */
  listSessions(workDir: string): Promise<SessionInfo[]>;

  /** List sessions across all work directories. */
  listAllSessions(): Promise<SessionInfo[]>;

  /** Resume the most recent session for a work directory. Returns null if none. */
  continueSession(workDir: string): Promise<string | null>;

  /** Delete a session by ID. */
  deleteSession(sessionId: string): Promise<void>;

  /** Fork a session, optionally at a specific turn. Returns the new session ID. */
  forkSession(sessionId: string, atTurn?: number): Promise<string>;

  /** Set a custom title for a session. */
  setSessionTitle(sessionId: string, title: string): Promise<void>;
}
