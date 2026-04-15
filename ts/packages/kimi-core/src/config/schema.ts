/**
 * Config schema — Zod-validated configuration types for kimi-core.
 *
 * Mirrors the Python `Config` / `LLMProvider` / `LLMModel` structure with
 * a simplified shape suitable for the TS rewrite.
 */

import { z } from 'zod';

// ── Provider config ─────────────────────────────────────────────────────

export const ProviderType = z.enum(['anthropic', 'openai', 'kimi', 'google-genai']);
export type ProviderType = z.infer<typeof ProviderType>;

export const ProviderConfigSchema = z.object({
  type: ProviderType,
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  defaultModel: z.string().optional(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

// ── Model alias ─────────────────────────────────────────────────────────

export const ModelAliasSchema = z.object({
  provider: z.string(),
  model: z.string(),
});

export type ModelAlias = z.infer<typeof ModelAliasSchema>;

// ── Thinking config ─────────────────────────────────────────────────────

export const ThinkingConfigSchema = z.object({
  mode: z.enum(['auto', 'on', 'off']).optional(),
  effort: z.string().optional(),
});

export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;

// ── Top-level KimiConfig ────────────────────────────────────────────────

export const KimiConfigSchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  models: z.record(z.string(), ModelAliasSchema).optional(),
  thinking: ThinkingConfigSchema.optional(),
  planMode: z.boolean().optional(),
  yolo: z.boolean().optional(),
});

export type KimiConfig = z.infer<typeof KimiConfigSchema>;

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
  };
}
