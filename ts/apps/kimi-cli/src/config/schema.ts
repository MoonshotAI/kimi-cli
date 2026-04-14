/**
 * Configuration schema for kimi-cli.
 *
 * Uses zod for runtime validation and type inference.  Every field mirrors the
 * Python `Config` pydantic model (see `src/kimi_cli/config.py`) with
 * TypeScript-idiomatic naming (camelCase in code, snake_case in TOML).
 *
 * TOML keys use snake_case; the zod schemas accept snake_case keys directly so
 * that parsed TOML objects validate without key transformation.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums / Literals
// ---------------------------------------------------------------------------

export const ProviderTypeSchema = z.enum([
  'kimi',
  'openai_legacy',
  'openai_responses',
  'anthropic',
  'google_genai',
  'gemini',
  'vertexai',
  '_echo',
  '_scripted_echo',
  '_chaos',
]);

export const ModelCapabilitySchema = z.enum([
  'image_in',
  'video_in',
  'thinking',
  'always_thinking',
]);

export const ThemeSchema = z.enum(['dark', 'light']);

export const HookEventTypeSchema = z.enum([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Notification',
]);

// ---------------------------------------------------------------------------
// Nested schemas
// ---------------------------------------------------------------------------

export const OAuthRefSchema = z.object({
  storage: z.enum(['keyring', 'file']).default('file'),
  key: z.string(),
});

export const LLMProviderSchema = z.object({
  type: ProviderTypeSchema,
  base_url: z.string(),
  api_key: z.string(),
  env: z.record(z.string()).optional(),
  custom_headers: z.record(z.string()).optional(),
  oauth: OAuthRefSchema.optional(),
});

export const LLMModelSchema = z.object({
  provider: z.string(),
  model: z.string(),
  max_context_size: z.number().int(),
  capabilities: z.array(ModelCapabilitySchema).optional(),
});

export const LoopControlSchema = z.object({
  max_steps_per_turn: z.number().int().min(1).default(100),
  max_retries_per_step: z.number().int().min(1).default(3),
  max_ralph_iterations: z.number().int().min(-1).default(0),
  reserved_context_size: z.number().int().min(1000).default(50_000),
  compaction_trigger_ratio: z.number().min(0.5).max(0.99).default(0.85),
});

export const BackgroundConfigSchema = z.object({
  max_running_tasks: z.number().int().min(1).default(4),
  read_max_bytes: z.number().int().min(1024).default(30_000),
  notification_tail_lines: z.number().int().min(1).default(20),
  notification_tail_chars: z.number().int().min(256).default(3_000),
  wait_poll_interval_ms: z.number().int().min(50).default(500),
  worker_heartbeat_interval_ms: z.number().int().min(100).default(5_000),
  worker_stale_after_ms: z.number().int().min(1000).default(15_000),
  kill_grace_period_ms: z.number().int().min(100).default(2_000),
  keep_alive_on_exit: z.boolean().default(false),
  agent_task_timeout_s: z.number().int().min(60).default(900),
});

export const NotificationConfigSchema = z.object({
  claim_stale_after_ms: z.number().int().min(1000).default(15_000),
});

export const MCPClientConfigSchema = z.object({
  tool_call_timeout_ms: z.number().int().default(60_000),
});

export const MCPConfigSchema = z.object({
  client: MCPClientConfigSchema.default({}),
});

export const MoonshotSearchConfigSchema = z.object({
  base_url: z.string(),
  api_key: z.string(),
  custom_headers: z.record(z.string()).optional(),
  oauth: OAuthRefSchema.optional(),
});

export const MoonshotFetchConfigSchema = z.object({
  base_url: z.string(),
  api_key: z.string(),
  custom_headers: z.record(z.string()).optional(),
  oauth: OAuthRefSchema.optional(),
});

export const ServicesSchema = z.object({
  moonshot_search: MoonshotSearchConfigSchema.optional(),
  moonshot_fetch: MoonshotFetchConfigSchema.optional(),
});

export const HookDefSchema = z.object({
  event: HookEventTypeSchema,
  command: z.string(),
  matcher: z.string().default(''),
  timeout: z.number().int().min(1).max(600).default(30),
});

// ---------------------------------------------------------------------------
// Top-level Config schema
// ---------------------------------------------------------------------------

export const ConfigSchema = z.object({
  default_model: z.string().default(''),
  default_thinking: z.boolean().default(false),
  default_yolo: z.boolean().default(false),
  default_plan_mode: z.boolean().default(false),
  default_editor: z.string().default(''),
  theme: ThemeSchema.default('dark'),
  merge_all_available_skills: z.boolean().default(false),

  loop_control: LoopControlSchema.default({}),
  background: BackgroundConfigSchema.default({}),
  notifications: NotificationConfigSchema.default({}),
  mcp: MCPConfigSchema.default({}),

  providers: z.record(LLMProviderSchema).default({}),
  models: z.record(LLMModelSchema).default({}),
  services: ServicesSchema.default({}),

  hooks: z.array(HookDefSchema).default([]),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Config = z.infer<typeof ConfigSchema>;
export type LoopControl = z.infer<typeof LoopControlSchema>;
export type BackgroundConfig = z.infer<typeof BackgroundConfigSchema>;
export type NotificationConfig = z.infer<typeof NotificationConfigSchema>;
export type MCPConfig = z.infer<typeof MCPConfigSchema>;
export type MCPClientConfig = z.infer<typeof MCPClientConfigSchema>;
export type LLMProvider = z.infer<typeof LLMProviderSchema>;
export type LLMModel = z.infer<typeof LLMModelSchema>;
export type Services = z.infer<typeof ServicesSchema>;
export type HookDef = z.infer<typeof HookDefSchema>;
export type OAuthRef = z.infer<typeof OAuthRefSchema>;
export type ProviderType = z.infer<typeof ProviderTypeSchema>;
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;
export type Theme = z.infer<typeof ThemeSchema>;
export type HookEventType = z.infer<typeof HookEventTypeSchema>;
