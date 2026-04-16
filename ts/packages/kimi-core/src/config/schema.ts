/**
 * Config schema — Zod-validated configuration types for kimi-core.
 *
 * Mirrors the Python `Config` / `LLMProvider` / `LLMModel` structure with
 * a simplified shape suitable for the TS rewrite.
 *
 * Each exported schema is annotated with `z.ZodType<T>`
 * so the file compiles under `--isolatedDeclarations`. Interfaces are
 * hand-declared rather than `z.infer`'d to avoid the circular type reference
 * that isolatedDeclarations forbids.
 */

import { z } from 'zod';

// ── Provider config ─────────────────────────────────────────────────────

export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'kimi'
  | 'google-genai'
  | 'openai_responses'
  | 'vertexai';

export const ProviderType: z.ZodType<ProviderType> = z.enum([
  'anthropic',
  'openai',
  'kimi',
  'google-genai',
  'openai_responses',
  'vertexai',
]);

export interface OAuthRef {
  storage?: string | undefined;
  key?: string | undefined;
}

export const OAuthRefSchema: z.ZodType<OAuthRef> = z.object({
  storage: z.string().optional(),
  key: z.string().optional(),
});

export interface ProviderConfig {
  type: ProviderType;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  defaultModel?: string | undefined;
  oauth?: OAuthRef | undefined;
}

export const ProviderConfigSchema: z.ZodType<ProviderConfig> = z.object({
  type: ProviderType,
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  defaultModel: z.string().optional(),
  oauth: OAuthRefSchema.optional(),
});

// ── Model alias ─────────────────────────────────────────────────────────

export interface ModelAlias {
  provider: string;
  model: string;
  maxContextSize?: number | undefined;
  capabilities?: string[] | undefined;
}

export const ModelAliasSchema: z.ZodType<ModelAlias> = z.object({
  provider: z.string(),
  model: z.string(),
  maxContextSize: z.number().optional(),
  capabilities: z.array(z.string()).optional(),
});

// ── Thinking config ─────────────────────────────────────────────────────

export interface ThinkingConfig {
  mode?: 'auto' | 'on' | 'off' | undefined;
  effort?: string | undefined;
}

export const ThinkingConfigSchema: z.ZodType<ThinkingConfig> = z.object({
  mode: z.enum(['auto', 'on', 'off']).optional(),
  effort: z.string().optional(),
});

// ── Top-level KimiConfig ────────────────────────────────────────────────

export interface KimiConfig {
  providers: Record<string, ProviderConfig>;
  defaultProvider?: string | undefined;
  defaultModel?: string | undefined;
  models?: Record<string, ModelAlias> | undefined;
  thinking?: ThinkingConfig | undefined;
  planMode?: boolean | undefined;
  yolo?: boolean | undefined;
  defaultThinking?: boolean | undefined;
  defaultYolo?: boolean | undefined;
  defaultPlanMode?: boolean | undefined;
  defaultEditor?: string | undefined;
  theme?: string | undefined;
  hooks?: unknown[] | undefined;
  mergeAllAvailableSkills?: boolean | undefined;
  showThinkingStream?: boolean | undefined;
  raw?: Record<string, unknown> | undefined;
}

export const KimiConfigSchema: z.ZodType<KimiConfig> = z.object({
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  models: z.record(z.string(), ModelAliasSchema).optional(),
  thinking: ThinkingConfigSchema.optional(),
  planMode: z.boolean().optional(),
  yolo: z.boolean().optional(),
  defaultThinking: z.boolean().optional(),
  defaultYolo: z.boolean().optional(),
  defaultPlanMode: z.boolean().optional(),
  defaultEditor: z.string().optional(),
  theme: z.string().optional(),
  hooks: z.array(z.unknown()).optional(),
  mergeAllAvailableSkills: z.boolean().optional(),
  showThinkingStream: z.boolean().optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

// ── Default config ──────────────────────────────────────────────────────

export function getDefaultConfig(): KimiConfig {
  return {
    providers: {},
    defaultProvider: undefined,
    defaultModel: undefined,
    models: undefined,
    thinking: undefined,
    planMode: undefined,
    yolo: undefined,
    defaultThinking: undefined,
    defaultYolo: undefined,
    defaultPlanMode: undefined,
    defaultEditor: undefined,
    theme: undefined,
    hooks: undefined,
    mergeAllAvailableSkills: undefined,
    showThinkingStream: undefined,
    raw: undefined,
  };
}
