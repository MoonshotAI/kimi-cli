/**
 * WireClient -- the contract between the CLI/TUI and the agent core.
 *
 * Wire 2.1 design:
 *  - `prompt()` is non-blocking, returns `{ turn_id }`.
 *  - Events arrive via `subscribe()` (independent of prompt).
 *  - Core-initiated requests (approval, question, hook) are responded
 *    to via `respondToRequest()`.
 *
 * `WireClientImpl` is the development-period implementation that
 * delegates to a `MockDataSource` for event generation.
 */

import type { WireMessage } from './wire-message.js';
import type {
  InitializeParams,
  InitializeResult,
  SessionInfo,
  SessionStatusResult,
  SessionUsageResult,
  ApprovalResponseData,
} from './methods.js';

// ── MockDataSource interface ────────────────────────────────────────

/**
 * The data source contract that WireClientImpl consumes.
 * During development this is satisfied by MockDataSource from the mock
 * module; in production it will be replaced by a stdio transport.
 */
export interface DataSource {
  /** Start producing events for a new turn. */
  startTurn(sessionId: string, turnId: string, input: string): void;
  /** Consume events (called by subscribe). */
  events(sessionId: string): AsyncIterable<WireMessage>;
  /** Resolve a Core-initiated request (e.g. approval). */
  resolveRequest(requestId: string, data: unknown): void;
  /** Cancel the current turn. */
  cancelTurn(sessionId: string): void;
  /** Session management store. */
  sessions: SessionStore;
}

export interface SessionStore {
  create(workDir: string): string;
  list(workDir: string): SessionInfo[];
  listAll(): SessionInfo[];
  delete(sessionId: string): void;
  fork(sessionId: string, atTurn?: number): string;
  setTitle(sessionId: string, title: string): void;
  get(sessionId: string): SessionInfo | undefined;
  recordTurn(sessionId: string, turnNumber: number): void;
}

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

  /** Fork a session. */
  fork(sessionId: string, atTurn?: number): Promise<{ session_id: string }>;
  /** Rename a session. */
  rename(sessionId: string, title: string): Promise<void>;
  /** Get session status snapshot. */
  getStatus(sessionId: string): Promise<SessionStatusResult>;
  /** Get token usage statistics. */
  getUsage(sessionId: string): Promise<SessionUsageResult>;
  /** Trigger manual compaction. */
  compact(sessionId: string): Promise<void>;

  /** Runtime model switch. */
  setModel(sessionId: string, model: string): Promise<void>;
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

  /** Release resources. */
  dispose(): Promise<void>;
}

// ── WireClientImpl (development period) ─────────────────────────────

export class WireClientImpl implements WireClient {
  private readonly dataSource: DataSource;
  private turnCounter = 0;

  constructor(dataSource: DataSource) {
    this.dataSource = dataSource;
  }

  // ── Handshake ───────────────────────────────────────────────────

  async initialize(_params: InitializeParams): Promise<InitializeResult> {
    return {
      protocol_version: '2.1',
      capabilities: {},
    };
  }

  // ── Session management ──────────────────────────────────────────

  async createSession(workDir: string): Promise<{ session_id: string }> {
    const id = this.dataSource.sessions.create(workDir);
    return { session_id: id };
  }

  async listSessions(): Promise<{ sessions: SessionInfo[] }> {
    return { sessions: this.dataSource.sessions.listAll() };
  }

  async destroySession(sessionId: string): Promise<void> {
    this.dataSource.sessions.delete(sessionId);
  }

  // ── Conversation ────────────────────────────────────────────────

  async prompt(sessionId: string, input: string): Promise<{ turn_id: string }> {
    this.turnCounter += 1;
    const turnId = `turn_${this.turnCounter}`;
    this.dataSource.startTurn(sessionId, turnId, input);
    this.dataSource.sessions.recordTurn(sessionId, this.turnCounter);
    return { turn_id: turnId };
  }

  async steer(_sessionId: string, _input: string): Promise<void> {
    // TODO: implement steer via data source
  }

  async cancel(sessionId: string): Promise<void> {
    this.dataSource.cancelTurn(sessionId);
  }

  async resume(_sessionId: string): Promise<void> {
    // No-op in mock
  }

  // ── Management ──────────────────────────────────────────────────

  async fork(sessionId: string, atTurn?: number): Promise<{ session_id: string }> {
    const id = this.dataSource.sessions.fork(sessionId, atTurn);
    return { session_id: id };
  }

  async rename(sessionId: string, title: string): Promise<void> {
    this.dataSource.sessions.setTitle(sessionId, title);
  }

  async getStatus(_sessionId: string): Promise<SessionStatusResult> {
    return { state: 'idle' };
  }

  async getUsage(_sessionId: string): Promise<SessionUsageResult> {
    return {
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
      total_cost_usd: 0,
    };
  }

  async compact(_sessionId: string): Promise<void> {
    // No-op in mock
  }

  // ── Configuration ───────────────────────────────────────────────

  async setModel(_sessionId: string, _model: string): Promise<void> {}
  async setThinking(_sessionId: string, _level: string): Promise<void> {}
  async setPlanMode(_sessionId: string, _enabled: boolean): Promise<void> {}
  async setYolo(_sessionId: string, _enabled: boolean): Promise<void> {}

  // ── Event subscription ──────────────────────────────────────────

  subscribe(sessionId: string): AsyncIterable<WireMessage> {
    return this.dataSource.events(sessionId);
  }

  // ── Bidirectional RPC ───────────────────────────────────────────

  respondToRequest(requestId: string, data: unknown): void {
    this.dataSource.resolveRequest(requestId, data);
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async dispose(): Promise<void> {
    // No-op in mock
  }
}

// ── Re-export for convenience ───────────────────────────────────────

export type { ApprovalResponseData };
