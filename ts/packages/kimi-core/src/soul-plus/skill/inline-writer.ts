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
import type { SkillDefinition } from './types.js';

export interface SkillInlineWriterDeps {
  readonly contextState: FullContextState;
  readonly sessionJournal: SessionJournal;
  /**
   * Optional turn-id resolver. The journal record requires a `turn_id`;
   * inline injections triggered between turns (e.g. before the first
   * user prompt) fall back to `'pending'`.
   */
  readonly currentTurnId?: () => string;
}

export class SkillInlineWriter {
  private readonly deps: SkillInlineWriterDeps;

  constructor(deps: SkillInlineWriterDeps) {
    this.deps = deps;
  }

  async inject(skill: SkillDefinition, args: string, depth: number): Promise<void> {
    const turnId = this.deps.currentTurnId?.() ?? 'pending';
    await this.deps.sessionJournal.appendSkillInvoked({
      type: 'skill_invoked',
      turn_id: turnId,
      data: {
        skill_name: skill.name,
        execution_mode: 'inline',
        original_input: args,
        invocation_trigger: 'claude-proactive',
        query_depth: depth,
      },
    });
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
