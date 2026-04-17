/**
 * SkillTool — Slice 7.1 (决策 #99).
 *
 * Collaboration tool that lets the LLM proactively invoke a registered
 * skill. Two execution modes:
 *   - Inline (default — `metadata.type` absent / `prompt` / `inline`):
 *     content is injected into ContextState via `SkillInlineWriter`. The
 *     calling turn continues; the skill body lands as a durable
 *     `<system-reminder>` the next `buildMessages()` will surface to
 *     the model.
 *   - Fork (`metadata.type` is `fork` or `standard`): a subagent is
 *     spawned through `SubagentHost.spawn` and the completion awaited
 *     in foreground. The result.text is returned as the tool result.
 *
 * Anti-loop: `MAX_SKILL_QUERY_DEPTH` caps Skill→Skill recursion so a
 * skill that re-invokes itself (or chains into another) cannot blow up
 * the call stack or the journal.
 */

import { z } from 'zod';

import type { Tool, ToolMetadata, ToolResult, ToolUpdate } from '../soul/types.js';
import type { SubagentHost } from '../soul-plus/subagent-types.js';
import type { SkillInlineWriter } from '../soul-plus/skill/inline-writer.js';
import type { SkillManager } from '../soul-plus/skill/types.js';
import { MAX_SKILL_QUERY_DEPTH } from '../soul-plus/subagent-constants.js';

export { MAX_SKILL_QUERY_DEPTH };

export interface SkillToolInput {
  skill: string;
  args?: string | undefined;
}

export const SkillToolInputSchema: z.ZodType<SkillToolInput> = z.object({
  skill: z.string(),
  args: z.string().optional(),
});

export interface SkillToolDeps {
  readonly skillManager: SkillManager;
  readonly inlineWriter: SkillInlineWriter;
  readonly subagentHost: SubagentHost;
  /**
   * Current recursion depth — the SkillTool created for a fresh main-agent
   * turn passes 0; the SkillTool wired into a Skill-spawned subagent
   * receives the parent's `skillContext.queryDepth`.
   */
  readonly queryDepth?: number | undefined;
  /**
   * Phase 17 §C.3 — alias for `queryDepth` used by
   * `SubagentRunner.run` when it forwards `skillContext.queryDepth`
   * into the child SkillTool. Kept as an explicit seam so call sites
   * reading the `SubagentRunner.run` contract can write
   * `initialQueryDepth` without needing to know the internal field
   * name. When both fields are set, `initialQueryDepth` wins.
   */
  readonly initialQueryDepth?: number | undefined;
  /**
   * Identifier passed as `parentAgentId` when spawning a fork-mode subagent.
   * Defaults to `'main'` so callers that don't know their own agent_id
   * (e.g. main-agent construction) can omit it.
   */
  readonly parentAgentId?: string | undefined;
}

export class SkillTool implements Tool<SkillToolInput> {
  readonly name = 'Skill';
  readonly description: string =
    'Invoke a registered skill from the current skill listing. ' +
    'BLOCKING REQUIREMENT: when a skill from the listing matches the user\'s ' +
    'request, you MUST call this tool (not free-form text). ' +
    'Do NOT call the same skill repeatedly inside one turn — recursive depth ' +
    `is capped at ${String(MAX_SKILL_QUERY_DEPTH)}.`;
  readonly inputSchema: typeof SkillToolInputSchema = SkillToolInputSchema;
  // Phase 17 §C.1 — provenance metadata parity with MCP adapter.
  readonly metadata: ToolMetadata = { source: 'sdk' };
  private readonly deps: SkillToolDeps;

  constructor(deps: SkillToolDeps) {
    this.deps = deps;
  }

  async execute(
    toolCallId: string,
    args: SkillToolInput,
    signal: AbortSignal,
    _onUpdate?: (u: ToolUpdate) => void,
  ): Promise<ToolResult> {
    void _onUpdate;
    // Phase 17 §C.3 — check recursion depth BEFORE any skill lookup so
    // the nested-depth guard fires even when the wiring is minimal
    // (tests construct SkillTool with only `initialQueryDepth` to
    // exercise the gate).
    const currentDepth = this.deps.initialQueryDepth ?? this.deps.queryDepth ?? 0;
    if (currentDepth >= MAX_SKILL_QUERY_DEPTH) {
      return errorResult(
        `Max skill query depth (${String(MAX_SKILL_QUERY_DEPTH)}) exceeded — refusing to recurse further.`,
      );
    }

    const skill = this.deps.skillManager.getSkill(args.skill);
    if (skill === undefined) {
      return errorResult(`Skill "${args.skill}" not found in the current skill listing.`);
    }
    if (skill.metadata.disableModelInvocation === true) {
      return errorResult(
        `Skill "${args.skill}" is user-only (disabled for model invocation).`,
      );
    }

    const nextDepth = currentDepth + 1;
    if (nextDepth > MAX_SKILL_QUERY_DEPTH) {
      return errorResult(
        `Max skill query depth (${String(MAX_SKILL_QUERY_DEPTH)}) exceeded — refusing to recurse further.`,
      );
    }

    const skillArgs = args.args ?? '';
    const skillType = skill.metadata.type;
    const isForkMode = skillType === 'fork' || skillType === 'standard';

    if (isForkMode) {
      // Forward the parent turn's AbortSignal so a parent abort cascades
      // into the spawned subagent (Slice 2.1 foreground abort cascade).
      const handle = await this.deps.subagentHost.spawn({
        parentAgentId: this.deps.parentAgentId ?? 'main',
        parentToolCallId: toolCallId,
        agentName: `skill-${skill.name}`,
        prompt: skillArgs.length > 0 ? `${skill.content}\n\n${skillArgs}` : skill.content,
        skillContext: { queryDepth: nextDepth },
        signal,
      });
      const result = await handle.completion;
      return { content: result.result };
    }

    await this.deps.inlineWriter.inject(skill, skillArgs, nextDepth);
    return {
      content: `Skill "${skill.name}" loaded inline. Follow its instructions.`,
    };
  }
}

function errorResult(message: string): ToolResult {
  return { isError: true, content: message };
}
