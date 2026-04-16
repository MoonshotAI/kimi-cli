/**
 * Configuration schema for kimi-cli.
 *
 * Uses zod for runtime validation and type inference.  Every field mirrors the
 * Python `Config` pydantic model (see `src/kimi_cli/config.py`) with
 * TypeScript-idiomatic naming (camelCase in code, snake_case in TOML).
 *
 * TOML keys use snake_case; the zod schemas accept snake_case keys directly so
 * that parsed TOML objects validate without key transformation.
 *
 * Each exported schema is annotated with an explicit `z.ZodType<T, z.ZodTypeDef, unknown>` so the
 * file compiles under `--isolatedDeclarations`. The `T` interfaces are
 * hand-written rather than `z.infer`'d to avoid the circular type reference
 * that isolatedDeclarations forbids.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums / Literals
// ---------------------------------------------------------------------------

export type ProviderType =
  | 'kimi'
  | 'openai_legacy'
  | 'openai_responses'
  | 'anthropic'
  | 'google_genai'
  | 'gemini'
  | 'vertexai'
  | '_echo'
  | '_scripted_echo'
  | '_chaos';

export const ProviderTypeSchema: z.ZodType<ProviderType, z.ZodTypeDef, unknown> = z.enum([
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

export type ModelCapability = 'image_in' | 'video_in' | 'thinking' | 'always_thinking';

export const ModelCapabilitySchema: z.ZodType<ModelCapability, z.ZodTypeDef, unknown> = z.enum([
  'image_in',
  'video_in',
  'thinking',
  'always_thinking',
]);

export type Theme = 'dark' | 'light';

export const ThemeSchema: z.ZodType<Theme, z.ZodTypeDef, unknown> = z.enum(['dark', 'light']);

export type HookEventType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'StopFailure'
  | 'SessionStart'
  | 'SessionEnd'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'Notification';

export const HookEventTypeSchema: z.ZodType<HookEventType, z.ZodTypeDef, unknown> = z.enum([
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

export interface OAuthRef {
  storage: 'keyring' | 'file';
  key: string;
}

export const OAuthRefSchema: z.ZodType<OAuthRef, z.ZodTypeDef, unknown> = z.object({
  storage: z.enum(['keyring', 'file']).default('file'),
  key: z.string(),
});

export interface LLMProvider {
  type: ProviderType;
  base_url: string;
  api_key: string;
  env?: Record<string, string> | undefined;
  custom_headers?: Record<string, string> | undefined;
  oauth?: OAuthRef | undefined;
}

export const LLMProviderSchema: z.ZodType<LLMProvider, z.ZodTypeDef, unknown> = z.object({
  type: ProviderTypeSchema,
  base_url: z.string(),
  api_key: z.string(),
  env: z.record(z.string()).optional(),
  custom_headers: z.record(z.string()).optional(),
  oauth: OAuthRefSchema.optional(),
});

export interface LLMModel {
  provider: string;
  model: string;
  max_context_size: number;
  capabilities?: ModelCapability[] | undefined;
}

export const LLMModelSchema: z.ZodType<LLMModel, z.ZodTypeDef, unknown> = z.object({
  provider: z.string(),
  model: z.string(),
  max_context_size: z.number().int(),
  capabilities: z.array(ModelCapabilitySchema).optional(),
});

export interface LoopControl {
  max_steps_per_turn: number;
  max_retries_per_step: number;
  max_ralph_iterations: number;
  reserved_context_size: number;
  compaction_trigger_ratio: number;
}

export const LoopControlSchema: z.ZodType<LoopControl, z.ZodTypeDef, unknown> = z.object({
  max_steps_per_turn: z.number().int().min(1).default(100),
  max_retries_per_step: z.number().int().min(1).default(3),
  max_ralph_iterations: z.number().int().min(-1).default(0),
  reserved_context_size: z.number().int().min(1000).default(50_000),
  compaction_trigger_ratio: z.number().min(0.5).max(0.99).default(0.85),
});

export interface BackgroundConfig {
  max_running_tasks: number;
  read_max_bytes: number;
  notification_tail_lines: number;
  notification_tail_chars: number;
  wait_poll_interval_ms: number;
  worker_heartbeat_interval_ms: number;
  worker_stale_after_ms: number;
  kill_grace_period_ms: number;
  keep_alive_on_exit: boolean;
  agent_task_timeout_s: number;
}

export const BackgroundConfigSchema: z.ZodType<BackgroundConfig, z.ZodTypeDef, unknown> = z.object({
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

export interface NotificationConfig {
  claim_stale_after_ms: number;
}

export const NotificationConfigSchema: z.ZodType<NotificationConfig, z.ZodTypeDef, unknown> =
  z.object({
    claim_stale_after_ms: z.number().int().min(1000).default(15_000),
  });

export interface MCPClientConfig {
  tool_call_timeout_ms: number;
}

export const MCPClientConfigSchema: z.ZodType<MCPClientConfig, z.ZodTypeDef, unknown> = z.object({
  tool_call_timeout_ms: z.number().int().default(60_000),
});

export interface MCPConfig {
  client: MCPClientConfig;
}

export const MCPConfigSchema: z.ZodType<MCPConfig, z.ZodTypeDef, unknown> = z.object({
  client: MCPClientConfigSchema.default({ tool_call_timeout_ms: 60_000 }),
});

export interface MoonshotSearchConfig {
  base_url: string;
  api_key: string;
  custom_headers?: Record<string, string> | undefined;
  oauth?: OAuthRef | undefined;
}

export const MoonshotSearchConfigSchema: z.ZodType<MoonshotSearchConfig, z.ZodTypeDef, unknown> =
  z.object({
    base_url: z.string(),
    api_key: z.string(),
    custom_headers: z.record(z.string()).optional(),
    oauth: OAuthRefSchema.optional(),
  });

export interface MoonshotFetchConfig {
  base_url: string;
  api_key: string;
  custom_headers?: Record<string, string> | undefined;
  oauth?: OAuthRef | undefined;
}

export const MoonshotFetchConfigSchema: z.ZodType<MoonshotFetchConfig, z.ZodTypeDef, unknown> =
  z.object({
    base_url: z.string(),
    api_key: z.string(),
    custom_headers: z.record(z.string()).optional(),
    oauth: OAuthRefSchema.optional(),
  });

export interface Services {
  moonshot_search?: MoonshotSearchConfig | undefined;
  moonshot_fetch?: MoonshotFetchConfig | undefined;
}

export const ServicesSchema: z.ZodType<Services, z.ZodTypeDef, unknown> = z.object({
  moonshot_search: MoonshotSearchConfigSchema.optional(),
  moonshot_fetch: MoonshotFetchConfigSchema.optional(),
});

export interface HookDef {
  event: HookEventType;
  command: string;
  matcher: string;
  timeout: number;
}

export const HookDefSchema: z.ZodType<HookDef, z.ZodTypeDef, unknown> = z.object({
  event: HookEventTypeSchema,
  command: z.string(),
  matcher: z.string().default(''),
  timeout: z.number().int().min(1).max(600).default(30),
});

// ---------------------------------------------------------------------------
// Top-level Config schema
// ---------------------------------------------------------------------------

export interface Config {
  default_model: string;
  default_thinking: boolean;
  default_yolo: boolean;
  default_plan_mode: boolean;
  default_editor: string;
  theme: Theme;
  merge_all_available_skills: boolean;
  show_thinking_stream: boolean;
  loop_control: LoopControl;
  background: BackgroundConfig;
  notifications: NotificationConfig;
  mcp: MCPConfig;
  providers: Record<string, LLMProvider>;
  models: Record<string, LLMModel>;
  services: Services;
  hooks: HookDef[];
}

export const ConfigSchema: z.ZodType<Config, z.ZodTypeDef, unknown> = z.object({
  default_model: z.string().default(''),
  default_thinking: z.boolean().default(false),
  default_yolo: z.boolean().default(false),
  default_plan_mode: z.boolean().default(false),
  default_editor: z.string().default(''),
  theme: ThemeSchema.default('dark'),
  merge_all_available_skills: z.boolean().default(false),
  show_thinking_stream: z.boolean().default(false),

  loop_control: LoopControlSchema.default({
    max_steps_per_turn: 100,
    max_retries_per_step: 3,
    max_ralph_iterations: 0,
    reserved_context_size: 50_000,
    compaction_trigger_ratio: 0.85,
  }),
  background: BackgroundConfigSchema.default({
    max_running_tasks: 4,
    read_max_bytes: 30_000,
    notification_tail_lines: 20,
    notification_tail_chars: 3_000,
    wait_poll_interval_ms: 500,
    worker_heartbeat_interval_ms: 5_000,
    worker_stale_after_ms: 15_000,
    kill_grace_period_ms: 2_000,
    keep_alive_on_exit: false,
    agent_task_timeout_s: 900,
  }),
  notifications: NotificationConfigSchema.default({ claim_stale_after_ms: 15_000 }),
  mcp: MCPConfigSchema.default({ client: { tool_call_timeout_ms: 60_000 } }),

  providers: z.record(LLMProviderSchema).default({}),
  models: z.record(LLMModelSchema).default({}),
  services: ServicesSchema.default({}),

  hooks: z.array(HookDefSchema).default([]),
});
