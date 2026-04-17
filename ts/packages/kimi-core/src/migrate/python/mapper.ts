// Python → TS field mapper. Pure functions that consume the reader output
// and return (ordered) TS WireRecord inputs — no I/O, no side effects.
//
// Design: we walk `context.jsonl` as the LLM history authority (§P0-1) and
// build lookup tables from `wire.jsonl` to enrich the per-line conversion
// with:
//   - tool result `is_error` (Python tool-role messages don't carry it)
//   - usage snapshots per assistant step (from StatusUpdate.token_usage)
//   - turn boundary timestamps (TurnBegin / TurnEnd / StepInterrupted)
//   - notifications, approvals, compaction events, subagent events
//
// The output shape is "AppendInput" from the journal writer — i.e. record
// bodies without `seq` / `time` so the writer can allocate them. We carry
// our own ordering discipline via the list order.

import { randomUUID } from 'node:crypto';

import type { AppendInput } from '../../storage/journal-writer.js';
import type {
  ApprovalDisplay,
  AssistantMessageRecord,
  NotificationRecord,
  ToolCallDispatchedRecord,
  ToolResultRecord,
  UserMessageRecord,
} from '../../storage/wire-record.js';
import { mapToolName } from './tool-name-map.js';
import type {
  PythonContentPart,
  PythonContextEntry,
  PythonMessage,
  PythonMessageContent,
  PythonSessionState,
  PythonToolCall,
  PythonWireRecord,
  PythonTokenUsage,
  PythonThinkPart,
} from './types.js';

// ── Content parsing (§P0-2 — single TextPart serialised to string) ────

export interface ParsedContent {
  readonly text: string;
  readonly thinkParts: readonly PythonThinkPart[];
  readonly droppedCount: number;
  readonly dropWarnings: readonly string[];
}

function isThinkPart(part: unknown): part is PythonThinkPart {
  return (
    part !== null &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'think' &&
    typeof (part as { think?: unknown }).think === 'string'
  );
}

export function parseContent(raw: PythonMessageContent | null | undefined): ParsedContent {
  if (raw === null || raw === undefined) {
    return { text: '', thinkParts: [], droppedCount: 0, dropWarnings: [] };
  }
  if (typeof raw === 'string') {
    return { text: raw, thinkParts: [], droppedCount: 0, dropWarnings: [] };
  }
  const textChunks: string[] = [];
  const thinkParts: PythonThinkPart[] = [];
  let droppedCount = 0;
  const dropWarnings: string[] = [];
  for (const part of raw) {
    const type = (part as { type?: unknown }).type;
    if (type === 'text') {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') textChunks.push(text);
      continue;
    }
    if (isThinkPart(part)) {
      thinkParts.push(part);
      continue;
    }
    if (type === 'image_url' || type === 'audio_url' || type === 'video_url') {
      droppedCount += 1;
      dropWarnings.push(`Dropped ${type} content part during migration`);
      continue;
    }
    droppedCount += 1;
    dropWarnings.push(`Dropped unsupported content part type "${String(type)}"`);
  }
  return { text: textChunks.join(''), thinkParts, droppedCount, dropWarnings };
}

// ── TokenUsage (§Q1) ──────────────────────────────────────────────────

export interface MappedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number | undefined;
  cache_write_tokens?: number | undefined;
}

export function mapTokenUsage(usage: PythonTokenUsage | undefined | null): MappedUsage | undefined {
  if (usage === null || usage === undefined) return undefined;
  const inputOther = usage.input_other ?? 0;
  const cacheRead = usage.input_cache_read ?? 0;
  const cacheWrite = usage.input_cache_creation ?? 0;
  const output = usage.output ?? 0;
  const result: MappedUsage = {
    // §Q1: TS input_tokens = total input (other + cache_read + cache_creation).
    input_tokens: inputOther + cacheRead + cacheWrite,
    output_tokens: output,
  };
  if (cacheRead > 0) result.cache_read_tokens = cacheRead;
  if (cacheWrite > 0) result.cache_write_tokens = cacheWrite;
  return result;
}

// ── wire.jsonl lookup tables ──────────────────────────────────────────

export interface WireLookups {
  /** tool_call_id → is_error from Python ToolResult.return_value.is_error. */
  readonly toolErrorById: ReadonlyMap<string, boolean>;
  /** tool_call_id → output (string / list content) from ToolResult. */
  readonly toolOutputById: ReadonlyMap<string, unknown>;
  /** Ordered StatusUpdate.token_usage snapshots, in wire.jsonl order. */
  readonly usageSnapshots: readonly (PythonTokenUsage | null)[];
  /** Ordered TurnBegin timestamps seen in wire.jsonl (used for turn boundaries). */
  readonly turnBeginTimes: readonly number[];
  /** Whether the last turn ended via StepInterrupted rather than TurnEnd. */
  readonly lastTurnInterrupted: boolean;
  /** Notification records, ordered. */
  readonly notifications: readonly PythonWireRecord[];
  /** ApprovalRequest / ApprovalResponse records, ordered. */
  readonly approvalEvents: readonly PythonWireRecord[];
  /** Compaction begin/end pairs — stored as count of completed pairs. */
  readonly compactionCount: number;
  /** SubagentEvent records — we only flag presence for a warning. */
  readonly subagentEventCount: number;
}

export function indexWireRecords(records: readonly PythonWireRecord[]): WireLookups {
  const toolErrorById = new Map<string, boolean>();
  const toolOutputById = new Map<string, unknown>();
  const usageSnapshots: (PythonTokenUsage | null)[] = [];
  const turnBeginTimes: number[] = [];
  const notifications: PythonWireRecord[] = [];
  const approvalEvents: PythonWireRecord[] = [];
  let compactionCount = 0;
  let subagentEventCount = 0;
  let lastWasInterrupted = false;

  for (const rec of records) {
    const type = rec.message.type;
    const payload = rec.message.payload;
    switch (type) {
      case 'ToolResult': {
        const returnValue = (payload as { return_value?: unknown }).return_value;
        const toolCallId = (payload as { tool_call_id?: unknown }).tool_call_id;
        if (
          typeof toolCallId === 'string' &&
          returnValue !== null &&
          typeof returnValue === 'object'
        ) {
          const rv = returnValue as { is_error?: unknown; output?: unknown };
          if (typeof rv.is_error === 'boolean') toolErrorById.set(toolCallId, rv.is_error);
          if (rv.output !== undefined) toolOutputById.set(toolCallId, rv.output);
        }
        break;
      }
      case 'StatusUpdate': {
        const tu = (payload as { token_usage?: unknown }).token_usage;
        if (tu !== null && tu !== undefined && typeof tu === 'object') {
          usageSnapshots.push(tu as PythonTokenUsage);
        } else {
          usageSnapshots.push(null);
        }
        break;
      }
      case 'TurnBegin':
        turnBeginTimes.push(rec.timestamp);
        lastWasInterrupted = false;
        break;
      case 'TurnEnd':
        lastWasInterrupted = false;
        break;
      case 'StepInterrupted':
        lastWasInterrupted = true;
        break;
      case 'Notification':
        notifications.push(rec);
        break;
      case 'ApprovalRequest':
      case 'ApprovalResponse':
      case 'ApprovalRequestResolved':
        approvalEvents.push(rec);
        break;
      case 'CompactionEnd':
        compactionCount += 1;
        break;
      case 'SubagentEvent':
        subagentEventCount += 1;
        break;
      default:
        break;
    }
  }

  return {
    toolErrorById,
    toolOutputById,
    usageSnapshots,
    turnBeginTimes,
    lastTurnInterrupted: lastWasInterrupted,
    notifications,
    approvalEvents,
    compactionCount,
    subagentEventCount,
  };
}

// ── Notification category mapping ─────────────────────────────────────

const NOTIFICATION_CATEGORIES = new Set<NotificationRecord['data']['category']>([
  'task',
  'agent',
  'system',
  'team',
]);

const NOTIFICATION_SEVERITIES = new Set<NotificationRecord['data']['severity']>([
  'info',
  'success',
  'warning',
  'error',
]);

function coerceNotificationCategory(raw: unknown): NotificationRecord['data']['category'] {
  if (
    typeof raw === 'string' &&
    NOTIFICATION_CATEGORIES.has(raw as NotificationRecord['data']['category'])
  ) {
    return raw as NotificationRecord['data']['category'];
  }
  return 'system';
}

function coerceNotificationSeverity(raw: unknown): NotificationRecord['data']['severity'] {
  if (
    typeof raw === 'string' &&
    NOTIFICATION_SEVERITIES.has(raw as NotificationRecord['data']['severity'])
  ) {
    return raw as NotificationRecord['data']['severity'];
  }
  return 'info';
}

// ── Approval display mapping (§5 P1-2) ────────────────────────────────

function mapApprovalDisplay(blocks: unknown): ApprovalDisplay {
  if (!Array.isArray(blocks)) {
    return { kind: 'generic', summary: 'migrated approval', detail: '' };
  }
  for (const block of blocks as readonly unknown[]) {
    if (block === null || typeof block !== 'object') continue;
    const type = (block as { type?: unknown }).type;
    if (type === 'shell' || type === 'command') {
      const command = (block as { command?: unknown }).command;
      return {
        kind: 'command',
        command: typeof command === 'string' ? command : '',
      };
    }
    if (type === 'diff') {
      const path = (block as { path?: unknown }).path;
      const diff = (block as { diff?: unknown }).diff;
      // Old `diff: string` payload collapses into the new `before/after`
      // pair by routing everything through `after` so the renderer can
      // still highlight the migrated patch.
      return {
        kind: 'diff',
        path: typeof path === 'string' ? path : '',
        before: '',
        after: typeof diff === 'string' ? diff : '',
      };
    }
    if (type === 'file_write') {
      const path = (block as { path?: unknown }).path;
      return {
        kind: 'file_io',
        operation: 'write',
        path: typeof path === 'string' ? path : '',
      };
    }
  }
  return {
    kind: 'generic',
    summary: 'migrated approval',
    detail: blocks,
  };
}

// ── Assistant tool call → TS tool_calls shape ─────────────────────────

function mapToolCalls(
  toolCalls: readonly PythonToolCall[] | null | undefined,
  override: Readonly<Record<string, string>> | undefined,
): Array<{ id: string; name: string; args: unknown }> {
  if (toolCalls === null || toolCalls === undefined) return [];
  const out: Array<{ id: string; name: string; args: unknown }> = [];
  for (const tc of toolCalls) {
    const rawArgs = tc.function?.arguments ?? null;
    let args: unknown;
    if (rawArgs === null || rawArgs === undefined) {
      args = {};
    } else {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        // Python stores arguments as a JSON string; if it's not parseable
        // (shouldn't happen but Python occasionally writes truncated partials),
        // fall back to a string payload so the caller still sees the raw.
        args = { _raw: rawArgs };
      }
    }
    out.push({
      id: tc.id,
      name: mapToolName(tc.function?.name ?? '', override),
      args,
    });
  }
  return out;
}

// ── Tool result content → TS output ───────────────────────────────────

function extractToolResultOutput(message: PythonMessage, wireOutput: unknown): unknown {
  if (wireOutput !== undefined) return wireOutput;
  // Fallback: synthesise from context.jsonl message.content.
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    const textChunks: string[] = [];
    for (const part of message.content as readonly PythonContentPart[]) {
      if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
        const t = (part as { text?: unknown }).text;
        if (typeof t === 'string') textChunks.push(t);
      }
    }
    return textChunks.join('');
  }
  return '';
}

// ── Result type for the mapper ────────────────────────────────────────

export interface MappedMigration {
  readonly records: readonly AppendInput[];
  readonly warnings: readonly string[];
  readonly droppedContentCount: number;
  readonly messageCount: number;
  readonly finalTitle: string | null;
  readonly finalPlanMode: boolean;
  readonly autoApproveActions: readonly string[];
}

export interface MapOptions {
  readonly toolNameMap?: Readonly<Record<string, string>> | undefined;
  readonly fallbackModel?: string | undefined;
}

// ── Main mapper ────────────────────────────────────────────────────────

/**
 * Translate Python session data into the sequence of TS WireRecord inputs
 * that should be appended to the new wire.jsonl.
 *
 * The output records are arranged:
 *   1. For each context.jsonl `_system_prompt` → `system_prompt_changed`
 *   2. For each user → assistant (→ tool_result …) cluster, emit a
 *      synthetic `turn_begin` / body / `turn_end` triplet.
 *   3. For each compaction pair seen in wire.jsonl, append one synthetic
 *      `compaction` placeholder at the end of the current turn boundary.
 *   4. Notifications / approval events are appended at the end because
 *      their original interleaving with context messages is unrecoverable
 *      (Python wire.jsonl / context.jsonl are independent writers).
 */
export function mapPythonToTsRecords(
  context: readonly PythonContextEntry[],
  wire: WireLookups,
  state: PythonSessionState | null,
  options: MapOptions,
): MappedMigration {
  const records: AppendInput[] = [];
  const warnings: string[] = [];
  let droppedContentCount = 0;
  let messageCount = 0;
  const fallbackModel = options.fallbackModel ?? state?.plan_slug ?? 'unknown';
  let currentTurnId: string | null = null;
  let currentTurnHasUserMsg = false;
  let usageCursor = 0;
  const totalUsageSnapshots = wire.usageSnapshots.length;

  function startTurnIfNeeded(): string {
    if (currentTurnId !== null) return currentTurnId;
    const turnId = `migrated-${randomUUID()}`;
    records.push({
      type: 'turn_begin',
      turn_id: turnId,
      agent_type: 'main',
      input_kind: 'user',
    });
    currentTurnId = turnId;
    currentTurnHasUserMsg = false;
    return turnId;
  }

  function endTurn(endOpts: { interrupted: boolean; lastUsage?: MappedUsage | undefined }): void {
    if (currentTurnId === null) return;
    const usageField =
      endOpts.lastUsage !== undefined
        ? {
            input_tokens: endOpts.lastUsage.input_tokens,
            output_tokens: endOpts.lastUsage.output_tokens,
            ...(endOpts.lastUsage.cache_read_tokens !== undefined
              ? { cache_read_tokens: endOpts.lastUsage.cache_read_tokens }
              : {}),
            ...(endOpts.lastUsage.cache_write_tokens !== undefined
              ? { cache_write_tokens: endOpts.lastUsage.cache_write_tokens }
              : {}),
          }
        : undefined;
    records.push({
      type: 'turn_end',
      turn_id: currentTurnId,
      agent_type: 'main',
      success: !endOpts.interrupted,
      reason: endOpts.interrupted ? 'interrupted' : 'done',
      ...(usageField !== undefined ? { usage: usageField } : {}),
    });
    currentTurnId = null;
    currentTurnHasUserMsg = false;
  }

  function consumeNextUsage(): MappedUsage | undefined {
    while (usageCursor < totalUsageSnapshots) {
      const candidate = wire.usageSnapshots[usageCursor];
      usageCursor += 1;
      if (candidate !== null) return mapTokenUsage(candidate);
    }
    return undefined;
  }

  for (const entry of context) {
    const role = (entry as { role?: unknown }).role;
    if (role === '_system_prompt') {
      const content = (entry as { content?: unknown }).content;
      if (typeof content === 'string') {
        records.push({ type: 'system_prompt_changed', new_prompt: content });
      }
      continue;
    }
    if (role === '_checkpoint') {
      // Checkpoints are a Python-side turn boundary. Use them to close any
      // in-flight synthetic turn cleanly so the next user message starts a
      // fresh turn.
      if (currentTurnId !== null) {
        endTurn({ interrupted: false });
      }
      continue;
    }
    if (role === '_usage') {
      // Drop: token estimates aren't authoritative.
      continue;
    }

    const msg = entry as PythonMessage;
    if (role === 'system') {
      const parsed = parseContent(msg.content);
      if (parsed.text.length > 0) {
        records.push({ type: 'system_prompt_changed', new_prompt: parsed.text });
      }
      continue;
    }

    if (role === 'user') {
      // A user message always starts a fresh turn (the prior turn, if any,
      // is closed with `done`).
      if (currentTurnId !== null && currentTurnHasUserMsg) {
        endTurn({ interrupted: false });
      }
      const parsed = parseContent(msg.content);
      droppedContentCount += parsed.droppedCount;
      warnings.push(...parsed.dropWarnings);
      const userTurnId = startTurnIfNeeded();
      const userRecord: Omit<UserMessageRecord, 'seq' | 'time'> = {
        type: 'user_message',
        turn_id: userTurnId,
        content: parsed.text,
      };
      records.push(userRecord);
      currentTurnHasUserMsg = true;
      messageCount += 1;
      continue;
    }

    if (role === 'assistant') {
      const turnId = startTurnIfNeeded();
      const parsed = parseContent(msg.content);
      droppedContentCount += parsed.droppedCount;
      warnings.push(...parsed.dropWarnings);
      const firstThink = parsed.thinkParts[0];
      const thinkText = firstThink !== undefined ? firstThink.think : null;
      const thinkSignature =
        firstThink !== undefined &&
        typeof firstThink.encrypted === 'string' &&
        firstThink.encrypted.length > 0
          ? firstThink.encrypted
          : undefined;
      const toolCalls = mapToolCalls(msg.tool_calls ?? null, options.toolNameMap);
      const usage = consumeNextUsage();
      const assistantRecord: Omit<AssistantMessageRecord, 'seq' | 'time'> = {
        type: 'assistant_message',
        turn_id: turnId,
        text: parsed.text.length > 0 ? parsed.text : null,
        think: thinkText,
        ...(thinkSignature !== undefined ? { think_signature: thinkSignature } : {}),
        tool_calls: toolCalls,
        model: fallbackModel,
        ...(usage !== undefined ? { usage } : {}),
      };
      records.push(assistantRecord);
      messageCount += 1;
      // Emit tool_call_dispatched records (Q3: type exists in TS, synthesise
      // one per tool call).
      const assistantMessageId = `migrated-msg-${records.length}`;
      for (const tc of toolCalls) {
        const dispatched: Omit<ToolCallDispatchedRecord, 'seq' | 'time'> = {
          type: 'tool_call_dispatched',
          turn_id: turnId,
          step: 0,
          data: {
            tool_call_id: tc.id,
            tool_name: tc.name,
            args: tc.args,
            assistant_message_id: assistantMessageId,
          },
        };
        records.push(dispatched);
      }
      continue;
    }

    if (role === 'tool') {
      const turnId = startTurnIfNeeded();
      const toolCallId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
      if (toolCallId.length === 0) {
        warnings.push('Tool result message missing tool_call_id, skipping');
        continue;
      }
      const wireOutput = wire.toolOutputById.get(toolCallId);
      const output = extractToolResultOutput(msg, wireOutput);
      const is_error = wire.toolErrorById.get(toolCallId);
      if (is_error === undefined) {
        warnings.push(`Tool result ${toolCallId}: no is_error in wire.jsonl, defaulting to false`);
      }
      const toolRecord: Omit<ToolResultRecord, 'seq' | 'time'> = {
        type: 'tool_result',
        turn_id: turnId,
        tool_call_id: toolCallId,
        output,
        is_error: is_error ?? false,
      };
      records.push(toolRecord);
      messageCount += 1;
      continue;
    }

    warnings.push(`Unknown context.jsonl role "${String(role)}" — skipping`);
  }

  if (currentTurnId !== null) {
    const lastUsage = consumeNextUsage();
    endTurn({ interrupted: wire.lastTurnInterrupted, lastUsage });
  }

  // Append Python compaction placeholders (§Q4).
  for (let i = 0; i < wire.compactionCount; i += 1) {
    records.push({
      type: 'compaction',
      summary: '[migrated from Python session]',
      compacted_range: { from_turn: 0, to_turn: 0, message_count: 0 },
      pre_compact_tokens: 0,
      post_compact_tokens: 0,
      trigger: 'auto',
    });
  }

  // Append notification + approval events.
  for (const rec of wire.notifications) {
    const payload = rec.message.payload;
    const rawCategory = payload['category'];
    const coerced = coerceNotificationCategory(rawCategory);
    if (coerced !== rawCategory) {
      warnings.push(
        `Notification category "${String(rawCategory)}" is not a known TS enum, falling back to "system"`,
      );
    }
    const str = (key: string, fallback: string): string =>
      typeof payload[key] === 'string' ? payload[key] : fallback;
    const notification: Omit<NotificationRecord, 'seq' | 'time'> = {
      type: 'notification',
      data: {
        id: str('id', randomUUID()),
        category: coerced,
        type: str('type', 'migrated'),
        source_kind: str('source_kind', 'migrated'),
        source_id: str('source_id', ''),
        title: str('title', ''),
        body: str('body', ''),
        severity: coerceNotificationSeverity(payload['severity']),
        targets: ['llm', 'wire', 'shell'],
        delivered_at: {},
      },
    };
    records.push(notification);
  }

  for (const rec of wire.approvalEvents) {
    const type = rec.message.type;
    const payload = rec.message.payload;
    const turnId = currentTurnId ?? `migrated-${randomUUID()}`;
    if (type === 'ApprovalRequest') {
      const reqId = typeof payload['id'] === 'string' ? payload['id'] : randomUUID();
      const toolCallId = typeof payload['tool_call_id'] === 'string' ? payload['tool_call_id'] : '';
      const action = typeof payload['action'] === 'string' ? payload['action'] : '';
      records.push({
        type: 'approval_request',
        turn_id: turnId,
        step: 0,
        data: {
          request_id: reqId,
          tool_call_id: toolCallId,
          tool_name: action,
          action,
          display: mapApprovalDisplay(payload['display']),
          source: { kind: 'soul', agent_id: 'migrated' },
        },
      });
    } else {
      // ApprovalResponse / ApprovalRequestResolved
      const rawResponse = payload['response'];
      const response =
        rawResponse === 'approve' || rawResponse === 'approve_for_session'
          ? 'approved'
          : rawResponse === 'reject'
            ? 'rejected'
            : 'cancelled';
      const respReqId = typeof payload['request_id'] === 'string' ? payload['request_id'] : '';
      const feedback = typeof payload['feedback'] === 'string' ? payload['feedback'] : '';
      records.push({
        type: 'approval_response',
        turn_id: turnId,
        step: 0,
        data: {
          request_id: respReqId,
          response,
          ...(feedback.length > 0 ? { feedback } : {}),
        },
      });
    }
  }

  if (wire.subagentEventCount > 0) {
    warnings.push(
      `Subagent sub-sessions not migrated (${wire.subagentEventCount} subagent events seen), handle separately`,
    );
  }

  return {
    records,
    warnings,
    droppedContentCount,
    messageCount,
    finalTitle: state?.custom_title ?? null,
    finalPlanMode: state?.plan_mode ?? false,
    autoApproveActions: Array.from(state?.approval?.auto_approve_actions ?? []),
  };
}
