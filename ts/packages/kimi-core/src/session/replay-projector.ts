/**
 * Replay Projector — build initial ContextState from replayed WireRecords
 * (Slice 3.4).
 *
 * Pure function: scans a `WireRecord[]` (output of `replayWire`) and
 * produces the data needed to hydrate a `WiredContextState` for session
 * resume WITHOUT re-writing any records to the journal.
 *
 * Record types that affect projected state:
 *   - `user_message`          → push user Message
 *   - `assistant_message`     → push assistant Message + accumulate tokens
 *   - `tool_result`           → push tool Message
 *   - `compaction`            → replace all prior messages with summary
 *   - `model_changed`         → update model
 *   - `system_prompt_changed` → update systemPrompt
 *   - `tools_changed`         → update activeTools
 *   - `permission_mode_changed` → update permissionMode
 *   - `plan_mode_changed`     → update planMode (Slice 5.2)
 *   - `context_cleared`       → reset messages + tokenCount (Slice 20-A)
 *
 * All other record types (turn_begin, turn_end, approval_*, notification,
 * etc.) are management-class and do not affect conversation projection.
 */

import type { ContentPart, Message, ToolCall } from '@moonshot-ai/kosong';

import type { PermissionMode } from '../soul-plus/permission/index.js';
import type { SessionInitializedRecord, WireRecord } from '../storage/wire-record.js';

/** Whitelist of valid PermissionMode values for safe runtime validation. */
const VALID_PERMISSION_MODES: ReadonlySet<string> = new Set<string>([
  'default',
  'acceptEdits',
  'bypassPermissions',
]);

export interface ReplayProjectedState {
  /** Conversation messages for `WiredContextState.initialHistory`. */
  readonly messages: readonly Message[];
  /** Final model after baseline + overlay (Phase 23: always set from init record). */
  readonly model: string;
  /** Final system prompt after baseline + overlay (Phase 23: always set). */
  readonly systemPrompt: string;
  /** Active tool set: baseline from init record + tools_changed overlays. */
  readonly activeTools: ReadonlySet<string>;
  /** `seq` of the last record — used as `JournalWriter.initialSeq`. */
  readonly lastSeq: number;
  /** Final permission mode after baseline + overlay (Phase 23: always set). */
  readonly permissionMode: PermissionMode;
  /** Accumulated token count (mirrors ContextState._tokenCountWithPending). */
  readonly tokenCount: number;
  /** Final plan mode after baseline + overlay (Phase 23: always set). */
  readonly planMode: boolean;
  /** Workspace dir captured in the session_initialized baseline. */
  readonly workspaceDir: string;
  /**
   * Phase 24 24b — thinking level from baseline `thinking_level` field or
   * last `thinking_changed` record. `undefined` when never set.
   */
  readonly thinkingLevel: string | undefined;
  /**
   * Phase 16 / 决策 #113 — merged sessionMeta patch, built by folding
   * `session_meta_changed` records in seq order and deriving:
   *   - `turn_count` from the count of `turn_begin` records
   *   - `last_model` from the last `model_changed` record
   * dirty-exit resume uses this to overwrite state.json derived fields.
   */
  readonly sessionMetaPatch: {
    title?: string | undefined;
    tags?: string[] | undefined;
    description?: string | undefined;
    archived?: boolean | undefined;
    color?: string | undefined;
    plan_slug?: string | undefined;
    turn_count: number;
    last_model?: string | undefined;
  };
}

/**
 * Project replayed WireRecords into the initial state needed to hydrate a
 * resumed `WiredContextState`.
 *
 * Phase 23 — the `sessionInitialized` baseline is the truth source for
 * startup config (system_prompt / model / active_tools / permission_mode /
 * plan_mode / workspace_dir). Subsequent `*_changed` records in `records`
 * overlay the baseline.
 *
 * @param records — ordered records from `replayWire().records`
 * @param sessionInitialized — the line-2 baseline from `replayWire().sessionInitialized`
 * @returns Projected state suitable for `WiredContextState` constructor.
 */
export function projectReplayState(
  records: readonly WireRecord[],
  sessionInitialized: SessionInitializedRecord,
): ReplayProjectedState {
  let messages: Message[] = [];
  let model: string = sessionInitialized.model;
  let systemPrompt: string = sessionInitialized.system_prompt;
  const activeTools = new Set<string>(sessionInitialized.active_tools);
  let lastSeq = 0;
  let permissionMode: PermissionMode = sessionInitialized.permission_mode;
  let tokenCount = 0;
  let planMode: boolean = sessionInitialized.plan_mode;
  let thinkingLevel: string | undefined = sessionInitialized.thinking_level;
  const workspaceDir: string = sessionInitialized.workspace_dir;
  const sessionMetaPatch: ReplayProjectedState['sessionMetaPatch'] = { turn_count: 0 };

  // Phase 25 Stage F (slice 25c-4a) — atomic step reconstruction state.
  // Accumulates text / think / tool_call parts for the currently open
  // step, then flushes into `messages` on `step_end`. Partial steps
  // (no step_end) are discarded at flush (decision C6 / H3) so a
  // half-finished assistant message never seeds the next LLM call.
  interface OpenStep {
    stepUuid: string;
    textChunks: string[];
    thinkChunks: string[];
    thinkEncrypted?: string | undefined;
    toolCalls: ToolCall[];
    hasStepEnd: boolean;
  }
  let openStep: OpenStep | null = null;

  function flushOpenStep(): void {
    if (openStep === null) return;
    if (!openStep.hasStepEnd) {
      // C6 / H3: partial step — discard entirely, do NOT push a
      // placeholder Message.
      openStep = null;
      return;
    }
    const content: ContentPart[] = [];
    if (openStep.thinkChunks.length > 0) {
      const thinkPart: ContentPart = {
        type: 'think',
        think: openStep.thinkChunks.join(''),
      };
      if (openStep.thinkEncrypted !== undefined) {
        (thinkPart as { encrypted?: string }).encrypted = openStep.thinkEncrypted;
      }
      content.push(thinkPart);
    }
    if (openStep.textChunks.length > 0) {
      content.push({ type: 'text', text: openStep.textChunks.join('') });
    }
    messages.push({
      role: 'assistant',
      content,
      toolCalls: openStep.toolCalls,
    });
    openStep = null;
  }

  for (const r of records) {
    if (r.seq > lastSeq) {
      lastSeq = r.seq;
    }

    switch (r.type) {
      case 'user_message': {
        flushOpenStep();
        // Phase 14 §3.5 — `content` may now be a UserInputPart[]. Reduce
        // back to the legacy text-only shape for replay consumers by
        // concatenating text parts; non-text attachments are surfaced as
        // `<image|video path=...>` placeholders so they survive replay
        // without needing multi-modal pipes here.
        const text =
          typeof r.content === 'string'
            ? r.content
            : r.content
                .map((part) => {
                  if (part.type === 'text') return part.text;
                  if (part.type === 'image_url') return `<image url="${part.image_url.url}">`;
                  return `<video url="${part.video_url.url}">`;
                })
                .join('');
        messages.push({
          role: 'user',
          content: [{ type: 'text', text }],
          toolCalls: [],
        });
        break;
      }

      case 'assistant_message': {
        flushOpenStep();
        const content: ContentPart[] = [];
        if (r.think !== null && r.think.length > 0) {
          const thinkPart: ContentPart = { type: 'think', think: r.think };
          if (r.think_signature !== undefined) {
            (thinkPart as { encrypted?: string }).encrypted = r.think_signature;
          }
          content.push(thinkPart);
        }
        if (r.text !== null && r.text.length > 0) {
          content.push({ type: 'text', text: r.text });
        }
        const toolCalls: ToolCall[] = r.tool_calls.map((tc) => ({
          type: 'function',
          id: tc.id,
          function: {
            name: tc.name,
            arguments: tc.args === undefined ? null : JSON.stringify(tc.args),
          },
        }));
        messages.push({ role: 'assistant', content, toolCalls });

        if (r.usage !== undefined) {
          tokenCount += r.usage.input_tokens + r.usage.output_tokens;
        }
        break;
      }

      case 'tool_result': {
        flushOpenStep();
        const text = typeof r.output === 'string' ? r.output : JSON.stringify(r.output);
        messages.push({
          role: 'tool',
          content: [{ type: 'text', text }],
          toolCalls: [],
          toolCallId: r.tool_call_id,
        });
        break;
      }

      case 'compaction': {
        flushOpenStep();
        // Replace all prior messages with the compaction summary.
        // Mirrors BaseContextState.resetToSummary().
        messages = [
          {
            role: 'assistant',
            content: [{ type: 'text', text: r.summary }],
            toolCalls: [],
          },
        ];
        tokenCount = r.post_compact_tokens;
        break;
      }

      case 'model_changed': {
        model = r.new_model;
        sessionMetaPatch.last_model = r.new_model;
        break;
      }

      case 'turn_begin': {
        // Phase 16 — derived turn_count. Other than this, turn_begin is a
        // management-class record that does not touch conversation state.
        sessionMetaPatch.turn_count += 1;
        break;
      }

      case 'session_meta_changed': {
        // Phase 16 — fold wire-truth patch fields. Absent fields keep
        // prior values; tags uses full-replace semantics.
        if (r.patch.title !== undefined) sessionMetaPatch.title = r.patch.title;
        if (r.patch.tags !== undefined) sessionMetaPatch.tags = [...r.patch.tags];
        if (r.patch.description !== undefined) {
          sessionMetaPatch.description = r.patch.description;
        }
        if (r.patch.archived !== undefined) sessionMetaPatch.archived = r.patch.archived;
        if (r.patch.color !== undefined) sessionMetaPatch.color = r.patch.color;
        if (r.patch.plan_slug !== undefined) sessionMetaPatch.plan_slug = r.patch.plan_slug;
        break;
      }

      case 'system_prompt_changed': {
        systemPrompt = r.new_prompt;
        break;
      }

      case 'tools_changed': {
        if (r.operation === 'set_active') {
          activeTools.clear();
          for (const t of r.tools) activeTools.add(t);
        } else if (r.operation === 'register') {
          for (const t of r.tools) activeTools.add(t);
        } else if (r.operation === 'remove') {
          for (const t of r.tools) activeTools.delete(t);
        }
        break;
      }

      case 'permission_mode_changed': {
        if (VALID_PERMISSION_MODES.has(r.data.to)) {
          permissionMode = r.data.to as PermissionMode;
        }
        break;
      }

      case 'plan_mode_changed': {
        // Slice 5.2 — last write wins; resume passes this into TurnManager.
        planMode = r.enabled;
        break;
      }

      case 'thinking_changed': {
        // Phase 24 24b — last write wins; resume restores via TurnManager.
        thinkingLevel = r.level;
        break;
      }

      case 'context_cleared': {
        flushOpenStep();
        // Slice 20-A — mirrors live `ContextState.clear()`: reset only
        // the accumulated conversation + token count. Config-class state
        // (model / systemPrompt / activeTools / permissionMode / planMode)
        // survives unchanged.
        messages = [];
        tokenCount = 0;
        break;
      }

      case 'step_begin': {
        flushOpenStep();
        openStep = {
          stepUuid: r.uuid,
          textChunks: [],
          thinkChunks: [],
          toolCalls: [],
          hasStepEnd: false,
        };
        break;
      }

      case 'content_part': {
        if (openStep === null || openStep.stepUuid !== r.step_uuid) {
          flushOpenStep();
          openStep = {
            stepUuid: r.step_uuid,
            textChunks: [],
            thinkChunks: [],
            toolCalls: [],
            hasStepEnd: false,
          };
        }
        if (r.part.kind === 'text') {
          openStep.textChunks.push(r.part.text);
        } else {
          openStep.thinkChunks.push(r.part.think);
          if (r.part.encrypted !== undefined) {
            openStep.thinkEncrypted = r.part.encrypted;
          }
        }
        break;
      }

      case 'tool_call': {
        if (openStep === null || openStep.stepUuid !== r.step_uuid) {
          flushOpenStep();
          openStep = {
            stepUuid: r.step_uuid,
            textChunks: [],
            thinkChunks: [],
            toolCalls: [],
            hasStepEnd: false,
          };
        }
        openStep.toolCalls.push({
          type: 'function',
          id: r.data.tool_call_id,
          function: {
            name: r.data.tool_name,
            arguments: r.data.args === undefined ? null : JSON.stringify(r.data.args),
          },
        });
        break;
      }

      case 'step_end': {
        if (openStep !== null && openStep.stepUuid === r.uuid) {
          openStep.hasStepEnd = true;
          if (r.usage !== undefined) {
            tokenCount += r.usage.input_tokens + r.usage.output_tokens;
          }
        }
        flushOpenStep();
        break;
      }

      // Management-class records — no effect on conversation projection.
      default:
        break;
    }
  }

  // Final flush for any open step at tail of records. Partial step (no
  // step_end) is discarded per C6 / H3.
  flushOpenStep();

  return {
    messages,
    model,
    systemPrompt,
    activeTools,
    lastSeq,
    permissionMode,
    tokenCount,
    planMode,
    thinkingLevel,
    workspaceDir,
    sessionMetaPatch,
  };
}
