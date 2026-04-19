/**
 * SkillInlineWriter — Slice 7.1 (决策 #99).
 *
 * Host-side writer that performs the dual side-effect of an inline-mode
 * skill invocation:
 *   1. WAL — append a `skill_invoked` record to the SessionJournal with
 *      `execution_mode='inline'`, `invocation_trigger='claude-proactive'`,
 *      and the caller-supplied `query_depth`.
 *   2. Mirror — wrap the skill content in `<kimi-skill-loaded ...>` XML
 *      and append it to ContextState via `appendSystemReminder`. The
 *      reminder is durable: it survives across turns and is visible on
 *      every subsequent `buildMessages()` call.
 *
 * WAL precedes mirror — if the journal write fails, the LLM never sees
 * the injected content.
 */

import type { FullContextState } from '../../storage/context-state.js';
import type { SessionJournal } from '../../storage/session-journal.js';
import type { SkillInvocationTrigger } from '../../storage/wire-record.js';
import type { SessionEventBus } from '../session-event-bus.js';
import type { SkillDefinition } from './types.js';

export type { SkillInvocationTrigger };

export interface SkillInlineWriterDeps {
  readonly contextState: FullContextState;
  readonly sessionJournal: SessionJournal;
  /**
   * Optional turn-id resolver. The journal record requires a `turn_id`;
   * inline injections triggered between turns (e.g. before the first
   * user prompt) fall back to `'pending'`.
   */
  readonly currentTurnId?: () => string;
  /**
   * Phase 24 Step 3 — EventBus for emitting skill.invoked SoulEvent
   * after the WAL record settles (铁律 L2.5: write before emit).
   * Optional so existing callers without eventBus keep compiling.
   */
  readonly eventBus?: SessionEventBus | undefined;
}

export class SkillInlineWriter {
  private readonly deps: SkillInlineWriterDeps;

  constructor(deps: SkillInlineWriterDeps) {
    this.deps = deps;
  }

  async inject(
    skill: SkillDefinition,
    args: string,
    depth: number,
    trigger: SkillInvocationTrigger = 'claude-proactive',
  ): Promise<void> {
    const turnId = this.deps.currentTurnId?.() ?? 'pending';
    const eventData = {
      skill_name: skill.name,
      execution_mode: 'inline' as const,
      original_input: args,
      invocation_trigger: trigger,
      query_depth: depth,
    };
    await this.deps.sessionJournal.appendSkillInvoked({
      type: 'skill_invoked',
      turn_id: turnId,
      data: eventData,
    });
    // Phase 24 L2.5: emit AFTER WAL write settles
    this.deps.eventBus?.emit({ type: 'skill.invoked', data: eventData });
    const wrapped =
      `<kimi-skill-loaded name="${escapeXml(skill.name)}" args="${escapeXml(args)}">\n` +
      `${skill.content}\n` +
      `</kimi-skill-loaded>`;
    await this.deps.contextState.appendSystemReminder({ content: wrapped });
  }
}

/**
 * D-3 — only the four canonical XML 1.0 entities. `'` is intentionally
 * NOT escaped; attribute values are always wrapped in double quotes.
 */
function escapeXml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
