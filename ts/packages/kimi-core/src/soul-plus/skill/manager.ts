/**
 * SkillManager — Slice 2.5.
 *
 * Holds the merged skill registry and exposes the public API used by
 * SoulPlus (`activate`, `listSkills`, `getKimiSkillsDescription`,
 * `getSkillRoots`). Slice 2.5 only implements the "inline" execution
 * mode: activation appends `skill.content + "\n\nUser request:\n" +
 * args` as a user message on the caller's `ContextState`. Fork mode,
 * TurnOverrides enforcement, and hook wiring are out of scope (D4).
 *
 * Ordering guarantees:
 *   - `init()` takes a list of filesystem skill roots and merges them
 *     first-wins + outer-first (builtin → user → project).
 *   - `registerBuiltinSkill` may be called before OR after `init()`.
 *     Filesystem-scanned skills always win over host-registered ones
 *     because the scan populates the registry from the outermost
 *     source first. Registering a name that already exists leaves
 *     the filesystem entry in place.
 */

import type { FullContextState } from '../../storage/context-state.js';
import { discoverSkills, type SkippedByPolicy } from './scanner.js';
import type {
  SkillActivationContext,
  SkillDefinition,
  SkillManager,
  SkillRoot,
  SkillSource,
} from './types.js';
import { SkillNotFoundError, normalizeSkillName } from './types.js';

/** Slice 7.1 (决策 #99) — max chars of `description` shown per skill. */
const SKILL_LISTING_DESC_MAX = 250;

export interface SkillManagerOptions {
  /**
   * Optional discovery override for tests. Real callers use the
   * default (`discoverSkills` from `scanner.ts`).
   */
  readonly discover?: typeof discoverSkills;
  /** Logger for parse / scan warnings. */
  readonly onWarning?: (message: string, cause?: unknown) => void;
}

export class DefaultSkillManager implements SkillManager {
  private readonly byName: Map<string, SkillDefinition> = new Map();
  private readonly rootPaths: string[] = [];
  private readonly discoverImpl: typeof discoverSkills;
  private readonly onWarning: (message: string, cause?: unknown) => void;
  private readonly skippedByPolicy: SkippedByPolicy[] = [];

  constructor(opts: SkillManagerOptions = {}) {
    this.discoverImpl = opts.discover ?? discoverSkills;
    this.onWarning = opts.onWarning ?? (() => {});
  }

  /**
   * Skills silently skipped during `init()` because their declared
   * `type` is outside the supported set (currently only flow skills
   * hit this path). Hosts may use this list for a `--verbose` summary
   * instead of stderr-spamming once per skill at startup.
   */
  getSkippedByPolicy(): readonly SkippedByPolicy[] {
    return this.skippedByPolicy;
  }

  /**
   * Scan a list of skill roots and merge them into the registry.
   * First-wins: if `registerBuiltinSkill` already registered a name,
   * the filesystem entry replaces it **only when the filesystem
   * skill comes from an outer source**. Since `init` consumes roots
   * in outer-first order and uses first-wins, the net effect is:
   * filesystem wins over host code for the outermost layer that
   * provides the name; within filesystem layers, earlier root wins.
   */
  async init(roots: readonly SkillRoot[]): Promise<void> {
    // Persist root paths for `getSkillRoots()` — additional_dirs
    // integration needs them regardless of how many skills each root
    // actually contains.
    for (const root of roots) {
      if (!this.rootPaths.includes(root.path)) {
        this.rootPaths.push(root.path);
      }
    }

    const discovered = await this.discoverImpl({
      roots,
      onWarning: this.onWarning,
      onSkippedByPolicy: (info) => this.skippedByPolicy.push(info),
    });

    // Filesystem-scanned skills take precedence: for each discovered
    // name we overwrite an already-registered host entry. Within the
    // discovered list the scanner already enforces first-wins
    // (outer-most root wins), so we simply iterate and `set`.
    for (const skill of discovered) {
      const key = normalizeSkillName(skill.name);
      this.byName.set(key, skill);
    }
  }

  getSkill(name: string): SkillDefinition | undefined {
    return this.byName.get(normalizeSkillName(name));
  }

  listSkills(): readonly SkillDefinition[] {
    return [...this.byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  async activate(name: string, args: string, context: SkillActivationContext): Promise<void> {
    const skill = this.getSkill(name);
    if (skill === undefined) {
      throw new SkillNotFoundError(name);
    }
    // Slice 7.1 (决策 #99) — user-slash invocation audit trail. Written
    // before the user_message mirror so the journal observes the same
    // WAL-then-mirror order as SkillInlineWriter (claude-proactive path).
    if (context.sessionJournal !== undefined) {
      await context.sessionJournal.appendSkillInvoked({
        type: 'skill_invoked',
        turn_id: context.turnId ?? 'pending',
        data: {
          skill_name: skill.name,
          execution_mode: 'inline',
          original_input: args,
          invocation_trigger: 'user-slash',
        },
      });
    }
    const prompt = buildInlinePrompt(skill.content, args);
    await context.contextState.appendUserMessage({ text: prompt });
  }

  registerBuiltinSkill(skill: SkillDefinition): void {
    const key = normalizeSkillName(skill.name);
    // First-wins against host code: only register if the name is
    // still free. A filesystem scan that ran earlier already owns
    // the slot; a filesystem scan that runs later will overwrite
    // this entry inside `init()`.
    if (!this.byName.has(key)) {
      // Ensure source is marked builtin even if the caller passed a
      // different label by accident.
      const normalised: SkillDefinition =
        skill.source === 'builtin' ? skill : { ...skill, source: 'builtin' as SkillSource };
      this.byName.set(key, normalised);
    }
  }

  getSkillRoots(): readonly string[] {
    return [...this.rootPaths];
  }

  getKimiSkillsDescription(): string {
    const skills = this.listSkills();
    if (skills.length === 0) return '';
    const lines: string[] = [];
    for (const skill of skills) {
      lines.push(`- ${skill.name}`);
      lines.push(`  - Path: ${skill.path}`);
      lines.push(`  - Description: ${skill.description}`);
    }
    return lines.join('\n');
  }

  // ── Slice 7.1 (决策 #99) — model-facing skill listing ─────────────────

  listInvocableSkills(): readonly SkillDefinition[] {
    return this.listSkills().filter((s) => s.metadata.disableModelInvocation !== true);
  }

  async injectSkillListing(contextState: FullContextState): Promise<void> {
    const invocable = this.listInvocableSkills();
    if (invocable.length === 0) return;
    const lines: string[] = [
      'DISREGARD any earlier skill listings. Current available skills:',
    ];
    for (const skill of invocable) {
      const desc = truncateDescription(skill.description);
      lines.push(`- ${skill.name}: ${desc}`);
      const whenToUse = skill.metadata.whenToUse;
      if (typeof whenToUse === 'string' && whenToUse.length > 0) {
        lines.push(`  When to use: ${whenToUse}`);
      }
      lines.push(`  Path: ${skill.path}`);
    }
    await contextState.appendSystemReminder({ content: lines.join('\n') });
  }
}

function truncateDescription(desc: string): string {
  return desc.length > SKILL_LISTING_DESC_MAX ? desc.slice(0, SKILL_LISTING_DESC_MAX) : desc;
}

/**
 * Build the inline-mode user message. Python `kimisoul.py:654-668`
 * uses the same template; mirroring it keeps SKILL.md content that
 * was authored for Python working unchanged.
 *
 * When `args` is empty, the "User request:" suffix is dropped so the
 * skill body stands alone (users who invoke `/commit` without args
 * should not see an empty trailing section).
 */
export function buildInlinePrompt(content: string, args: string): string {
  const trimmed = args.trim();
  if (trimmed === '') return content;
  return `${content}\n\nUser request:\n${trimmed}`;
}
