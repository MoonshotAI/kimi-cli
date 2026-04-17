import type { JournalWriter } from './journal-writer.js';
import type { JournalInput, WireRecord } from './wire-record.js';

/** All WireRecord types that flow through SessionJournal (§4.5.6). */
export type SessionJournalRecord = Extract<
  WireRecord,
  {
    type:
      | 'turn_begin'
      | 'turn_end'
      | 'skill_invoked'
      | 'skill_completed'
      | 'approval_request'
      | 'approval_response'
      | 'team_mail'
      | 'tool_call_dispatched'
      | 'permission_mode_changed'
      | 'tool_denied'
      | 'subagent_spawned'
      | 'subagent_completed'
      | 'subagent_failed'
      | 'ownership_changed'
      | 'session_meta_changed';
  }
>;

/**
 * Management-class WAL window. Does NOT touch conversation projection
 * memory — it only builds records and delegates to the shared JournalWriter.
 */
export interface SessionJournal {
  appendTurnBegin(data: JournalInput<'turn_begin'>): Promise<void>;
  appendTurnEnd(data: JournalInput<'turn_end'>): Promise<void>;
  appendSkillInvoked(data: JournalInput<'skill_invoked'>): Promise<void>;
  appendSkillCompleted(data: JournalInput<'skill_completed'>): Promise<void>;
  appendApprovalRequest(data: JournalInput<'approval_request'>): Promise<void>;
  appendApprovalResponse(data: JournalInput<'approval_response'>): Promise<void>;
  appendTeamMail(data: JournalInput<'team_mail'>): Promise<void>;
  appendToolCallDispatched(data: JournalInput<'tool_call_dispatched'>): Promise<void>;
  appendPermissionModeChanged(data: JournalInput<'permission_mode_changed'>): Promise<void>;
  appendToolDenied(data: JournalInput<'tool_denied'>): Promise<void>;
  // Phase 1 (方案 A): appendNotification / appendSystemReminder removed.
  // These record types are now written exclusively by ContextState
  // (appendNotification / appendSystemReminder), which owns both the
  // WAL write and the in-memory mirror.
  // Phase 6 / 决策 #88: the legacy `appendSubagentEvent` (which bubbled
  // child SoulEvent snapshots up via the `subagent_event` envelope) is
  // gone. Each subagent now writes its own `wire.jsonl` through an
  // independent JournalWriter. The parent journal records only the three
  // lifecycle references defined by §3.6.1.
  appendSubagentSpawned(data: JournalInput<'subagent_spawned'>): Promise<void>;
  appendSubagentCompleted(data: JournalInput<'subagent_completed'>): Promise<void>;
  appendSubagentFailed(data: JournalInput<'subagent_failed'>): Promise<void>;
  appendOwnershipChanged(data: JournalInput<'ownership_changed'>): Promise<void>;
  /**
   * Phase 16 / 决策 #113 — sessionMeta wire-truth append. Consumed only
   * by SessionMetaService on user-triggered edits (title / tags / …);
   * derived fields (turn_count / last_model / last_updated) never land
   * through this channel — they stay in memory + state.json.
   */
  appendSessionMetaChanged(data: JournalInput<'session_meta_changed'>): Promise<void>;
}

export interface InMemorySessionJournal extends SessionJournal {
  getRecords(): readonly SessionJournalRecord[];
  getRecordsByType<T extends SessionJournalRecord['type']>(
    type: T,
  ): Extract<SessionJournalRecord, { type: T }>[];
  clear(): void;
}

/**
 * Production `SessionJournal` implementation — delegates every append to the
 * shared `JournalWriter`, which in turn serialises to wire.jsonl.
 *
 * Does not mutate any conversation projection state (per §4.5.6 "management
 * class records do not change buildMessages()").
 */
export class WiredSessionJournalImpl implements SessionJournal {
  constructor(private readonly journalWriter: JournalWriter) {}

  async appendTurnBegin(data: JournalInput<'turn_begin'>): Promise<void> {
    await this.journalWriter.append(data);
  }

  async appendTurnEnd(data: JournalInput<'turn_end'>): Promise<void> {
    await this.journalWriter.append(data);
  }

  async appendSkillInvoked(data: JournalInput<'skill_invoked'>): Promise<void> {
    await this.journalWriter.append(data);
  }

  async appendSkillCompleted(data: JournalInput<'skill_completed'>): Promise<void> {
    await this.journalWriter.append(data);
  }

  async appendApprovalRequest(data: JournalInput<'approval_request'>): Promise<void> {
    await this.journalWriter.append(data);
  }

  async appendApprovalResponse(data: JournalInput<'approval_response'>): Promise<void> {
    await this.journalWriter.append(data);
  }

  async appendTeamMail(data: JournalInput<'team_mail'>): Promise<void> {
    await this.journalWriter.append(data);
  }

  async appendToolCallDispatched(data: JournalInput<'tool_call_dispatched'>): Promise<void> {
    await this.journalWriter.append(data);
  }

  async appendPermissionModeChanged(data: JournalInput<'permission_mode_changed'>): Promise<void> {
    await this.journalWriter.append(data);
  }

  async appendToolDenied(data: JournalInput<'tool_denied'>): Promise<void> {
    await this.journalWriter.append(data);
  }

  async appendSubagentSpawned(data: JournalInput<'subagent_spawned'>): Promise<void> {
    await this.journalWriter.append(data);
  }

  async appendSubagentCompleted(data: JournalInput<'subagent_completed'>): Promise<void> {
    await this.journalWriter.append(data);
  }

  async appendSubagentFailed(data: JournalInput<'subagent_failed'>): Promise<void> {
    await this.journalWriter.append(data);
  }

  async appendOwnershipChanged(data: JournalInput<'ownership_changed'>): Promise<void> {
    await this.journalWriter.append(data);
  }

  async appendSessionMetaChanged(
    data: JournalInput<'session_meta_changed'>,
  ): Promise<void> {
    await this.journalWriter.append(data);
  }
}

/**
 * In-memory `SessionJournal` used by embed / e2e scenarios. Keeps every
 * record in a buffer so tests can assert on turn boundaries / approval
 * flows / notifications without touching the filesystem.
 */
export class InMemorySessionJournalImpl implements InMemorySessionJournal {
  private readonly buffer: SessionJournalRecord[] = [];
  private seq = 0;

  private now(): number {
    return Date.now();
  }

  private push<T extends SessionJournalRecord['type']>(data: JournalInput<T>): void {
    this.seq += 1;
    const record = {
      ...data,
      seq: this.seq,
      time: this.now(),
    } as unknown as SessionJournalRecord;
    this.buffer.push(record);
  }

  async appendTurnBegin(data: JournalInput<'turn_begin'>): Promise<void> {
    this.push<'turn_begin'>(data);
  }

  async appendTurnEnd(data: JournalInput<'turn_end'>): Promise<void> {
    this.push<'turn_end'>(data);
  }

  async appendSkillInvoked(data: JournalInput<'skill_invoked'>): Promise<void> {
    this.push<'skill_invoked'>(data);
  }

  async appendSkillCompleted(data: JournalInput<'skill_completed'>): Promise<void> {
    this.push<'skill_completed'>(data);
  }

  async appendApprovalRequest(data: JournalInput<'approval_request'>): Promise<void> {
    this.push<'approval_request'>(data);
  }

  async appendApprovalResponse(data: JournalInput<'approval_response'>): Promise<void> {
    this.push<'approval_response'>(data);
  }

  async appendTeamMail(data: JournalInput<'team_mail'>): Promise<void> {
    this.push<'team_mail'>(data);
  }

  async appendToolCallDispatched(data: JournalInput<'tool_call_dispatched'>): Promise<void> {
    this.push<'tool_call_dispatched'>(data);
  }

  async appendPermissionModeChanged(data: JournalInput<'permission_mode_changed'>): Promise<void> {
    this.push<'permission_mode_changed'>(data);
  }

  async appendToolDenied(data: JournalInput<'tool_denied'>): Promise<void> {
    this.push<'tool_denied'>(data);
  }

  async appendSubagentSpawned(data: JournalInput<'subagent_spawned'>): Promise<void> {
    this.push<'subagent_spawned'>(data);
  }

  async appendSubagentCompleted(data: JournalInput<'subagent_completed'>): Promise<void> {
    this.push<'subagent_completed'>(data);
  }

  async appendSubagentFailed(data: JournalInput<'subagent_failed'>): Promise<void> {
    this.push<'subagent_failed'>(data);
  }

  async appendOwnershipChanged(data: JournalInput<'ownership_changed'>): Promise<void> {
    this.push<'ownership_changed'>(data);
  }

  async appendSessionMetaChanged(
    data: JournalInput<'session_meta_changed'>,
  ): Promise<void> {
    this.push<'session_meta_changed'>(data);
  }

  getRecords(): readonly SessionJournalRecord[] {
    return this.buffer;
  }

  getRecordsByType<T extends SessionJournalRecord['type']>(
    type: T,
  ): Extract<SessionJournalRecord, { type: T }>[] {
    return this.buffer.filter(
      (r): r is Extract<SessionJournalRecord, { type: T }> => r.type === type,
    );
  }

  clear(): void {
    this.buffer.length = 0;
  }
}
