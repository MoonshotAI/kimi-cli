/**
 * Agent specification types — Slice 3.1.
 *
 * Models the YAML agent file schema. Fields use `undefined` to mean
 * "not specified / inherit from parent" — the TS equivalent of
 * Python's `Inherit` sentinel.
 */

export interface AgentSpec {
  readonly name: string;
  readonly description?: string | undefined;
  /** Inline system prompt text. Mutually exclusive with `systemPromptPath`. */
  readonly systemPrompt?: string | undefined;
  /** Path to a system prompt file (resolved relative to agent.yaml). */
  readonly systemPromptPath?: string | undefined;
  readonly model?: string | undefined;
  readonly thinkingMode?: 'auto' | 'on' | 'off' | undefined;
  readonly thinkingEffort?: string | undefined;
  readonly tools?: ToolFilter | undefined;
  readonly skills?: SkillFilter | undefined;
  /** Parent agent name to inherit from. */
  readonly inherits?: string | undefined;
  /** Extension fields for forward compatibility. */
  readonly [key: string]: unknown;
}

export interface ToolFilter {
  readonly include?: readonly string[] | undefined;
  readonly exclude?: readonly string[] | undefined;
}

export interface SkillFilter {
  readonly include?: readonly string[] | undefined;
  readonly exclude?: readonly string[] | undefined;
}

/**
 * Context for template variable expansion.
 */
export interface TemplateContext {
  readonly workspaceDir: string;
  readonly userName?: string | undefined;
  readonly os?: string | undefined;
  readonly date?: string | undefined;
  readonly kimiSkills?: string | undefined;
  readonly kimiHome?: string | undefined;
  readonly [key: string]: string | undefined;
}
