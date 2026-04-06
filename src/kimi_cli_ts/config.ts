/**
 * Configuration module — corresponds to Python config.py
 * Loads/saves TOML config with Zod validation.
 */

import { z } from "zod/v4";
import TOML from "@iarna/toml";
import { ModelCapability } from "./types.ts";

// ── Sub-schemas ─────────────────────────────────────────

export const OAuthRef = z.object({
	storage: z.enum(["keyring", "file"]).default("file"),
	key: z.string(),
});
export type OAuthRef = z.infer<typeof OAuthRef>;

export const ProviderType = z.enum([
	"kimi",
	"openai_legacy",
	"openai_responses",
	"anthropic",
	"google_genai",
	"gemini",
	"vertexai",
	"_echo",
	"_scripted_echo",
	"_chaos",
]);
export type ProviderType = z.infer<typeof ProviderType>;

export const LLMProvider = z.object({
	type: ProviderType,
	base_url: z.string(),
	api_key: z.string(),
	env: z.record(z.string(), z.string()).optional(),
	custom_headers: z.record(z.string(), z.string()).optional(),
	oauth: OAuthRef.optional(),
});
export type LLMProvider = z.infer<typeof LLMProvider>;

export const LLMModel = z.object({
	provider: z.string(),
	model: z.string(),
	max_context_size: z.number().int(),
	capabilities: z.array(ModelCapability).optional(),
});
export type LLMModel = z.infer<typeof LLMModel>;

export const LoopControl = z.object({
	max_steps_per_turn: z.number().int().min(1).default(100),
	max_retries_per_step: z.number().int().min(1).default(3),
	max_ralph_iterations: z.number().int().min(-1).default(0),
	reserved_context_size: z.number().int().min(1000).default(50_000),
	compaction_trigger_ratio: z.number().min(0.5).max(0.99).default(0.85),
});
export type LoopControl = z.infer<typeof LoopControl>;

export const BackgroundConfig = z.object({
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
export type BackgroundConfig = z.infer<typeof BackgroundConfig>;

export const NotificationConfig = z.object({
	claim_stale_after_ms: z.number().int().min(1000).default(15_000),
});
export type NotificationConfig = z.infer<typeof NotificationConfig>;

export const MoonshotSearchConfig = z.object({
	base_url: z.string(),
	api_key: z.string(),
	custom_headers: z.record(z.string(), z.string()).optional(),
	oauth: OAuthRef.optional(),
});
export type MoonshotSearchConfig = z.infer<typeof MoonshotSearchConfig>;

export const MoonshotFetchConfig = z.object({
	base_url: z.string(),
	api_key: z.string(),
	custom_headers: z.record(z.string(), z.string()).optional(),
	oauth: OAuthRef.optional(),
});
export type MoonshotFetchConfig = z.infer<typeof MoonshotFetchConfig>;

export const Services = z.object({
	moonshot_search: MoonshotSearchConfig.optional(),
	moonshot_fetch: MoonshotFetchConfig.optional(),
});
export type Services = z.infer<typeof Services>;

export const MCPClientConfig = z.object({
	tool_call_timeout_ms: z.number().int().default(60000),
});
export type MCPClientConfig = z.infer<typeof MCPClientConfig>;

export const MCPConfig = z.object({
	client: MCPClientConfig.default(() => MCPClientConfig.parse({})),
});
export type MCPConfig = z.infer<typeof MCPConfig>;

export const HookEventType = z.enum([
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"UserPromptSubmit",
	"Stop",
	"StopFailure",
	"SessionStart",
	"SessionEnd",
	"SubagentStart",
	"SubagentStop",
	"PreCompact",
	"PostCompact",
	"Notification",
]);
export type HookEventType = z.infer<typeof HookEventType>;

export const HookDef = z.object({
	event: HookEventType,
	command: z.string(),
	matcher: z.string().default(""),
	timeout: z.number().int().min(1).max(600).default(30),
});
export type HookDef = z.infer<typeof HookDef>;

export const Config = z
	.object({
		default_model: z.string().default(""),
		default_thinking: z.boolean().default(false),
		default_yolo: z.boolean().default(false),
		default_plan_mode: z.boolean().default(false),
		default_editor: z.string().default(""),
		theme: z.enum(["dark", "light"]).default("dark"),
		models: z.record(z.string(), LLMModel).default({}),
		providers: z.record(z.string(), LLMProvider).default({}),
		loop_control: LoopControl.default(() => LoopControl.parse({})),
		background: BackgroundConfig.default(() => BackgroundConfig.parse({})),
		notifications: NotificationConfig.default(() => NotificationConfig.parse({})),
		services: Services.default({}),
		mcp: MCPConfig.default(() => MCPConfig.parse({})),
		hooks: z.array(HookDef).default([]),
		merge_all_available_skills: z.boolean().default(false),
	})
	.refine(
		(cfg) => {
			if (cfg.default_model && !(cfg.default_model in cfg.models)) return false;
			for (const m of Object.values(cfg.models) as LLMModel[]) {
				if (!(m.provider in cfg.providers)) return false;
			}
			return true;
		},
		{
			message:
				"default_model must exist in models, and all model providers must exist in providers",
		},
	);

export type Config = z.infer<typeof Config>;

/** Runtime metadata attached after loading (not persisted). */
export interface ConfigMeta {
	isFromDefaultLocation: boolean;
	sourceFile: string | null;
}

// ── Paths ───────────────────────────────────────────────

import { join, resolve } from "node:path";
import { ConfigError } from "./exception.ts";

export { ConfigError };

// Re-export from canonical location (share.ts) for backwards compatibility
export { getShareDir } from "./share.ts";
import { getShareDir } from "./share.ts";

export function getConfigFile(): string {
	return join(getShareDir(), "config.toml");
}

// ── Secret masking helper ────────────────────────────────

/** Mask a secret string for safe logging (shows first 4 chars + ***). */
export function maskSecret(value: string): string {
	if (!value || value.length <= 4) return "***";
	return value.slice(0, 4) + "***";
}

// ── JSON → TOML migration ───────────────────────────────

async function migrateJsonConfigToToml(): Promise<void> {
	const oldJsonConfigFile = join(getShareDir(), "config.json");
	const newTomlConfigFile = join(getShareDir(), "config.toml");

	const oldFile = Bun.file(oldJsonConfigFile);
	const newFile = Bun.file(newTomlConfigFile);
	if (!(await oldFile.exists())) return;
	if (await newFile.exists()) return;

	try {
		const data = await oldFile.json();
		const config = Config.parse(data);
		await saveConfig(config, newTomlConfigFile);
		// Backup old file
		const backupPath = oldJsonConfigFile.replace(/\.json$/, ".json.bak");
		await Bun.$`mv ${oldJsonConfigFile} ${backupPath}`.quiet();
	} catch (err) {
		// If migration fails, continue with default config
	}
}

export function getDefaultConfig(): Config {
	return Config.parse({});
}

export async function loadConfig(
	configFile?: string,
): Promise<{ config: Config; meta: ConfigMeta }> {
	const defaultConfigFile = resolve(getConfigFile());
	const resolvedPath = configFile ? resolve(configFile) : defaultConfigFile;
	const isDefault = resolvedPath === defaultConfigFile;

	// If using default config and it doesn't exist, try migrating from JSON
	if (isDefault) {
		const file = Bun.file(resolvedPath);
		if (!(await file.exists())) {
			await migrateJsonConfigToToml();
		}
	}

	const file = Bun.file(resolvedPath);
	if (!(await file.exists())) {
		const config = getDefaultConfig();
		await saveConfig(config, resolvedPath);
		return {
			config,
			meta: { isFromDefaultLocation: isDefault, sourceFile: resolvedPath },
		};
	}

	try {
		const text = await file.text();
		let data: unknown;
		if (resolvedPath.toLowerCase().endsWith(".json")) {
			data = JSON.parse(text);
		} else {
			const rawData = TOML.parse(text);
			// @iarna/toml adds Symbol properties that break Zod validation — strip them via JSON roundtrip
			data = JSON.parse(JSON.stringify(rawData));
		}
		const config = Config.parse(data);

		// Environment variable overrides
		if (process.env.KIMI_MODEL_NAME)
			config.default_model = process.env.KIMI_MODEL_NAME;

		return {
			config,
			meta: { isFromDefaultLocation: isDefault, sourceFile: resolvedPath },
		};
	} catch (err) {
		if (err instanceof z.ZodError) {
			throw new ConfigError(
				`Invalid configuration file ${resolvedPath}: ${err.message}`,
			);
		}
		throw new ConfigError(
			`Failed to parse configuration file ${resolvedPath}: ${err}`,
		);
	}
}

export async function loadConfigFromString(
	text: string,
): Promise<{ config: Config; meta: ConfigMeta }> {
	if (!text.trim()) throw new ConfigError("Configuration text cannot be empty");

	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		try {
			data = TOML.parse(text);
		} catch (tomlErr) {
			throw new ConfigError(`Invalid configuration text: ${tomlErr}`);
		}
	}

	try {
		const config = Config.parse(data);
		return { config, meta: { isFromDefaultLocation: false, sourceFile: null } };
	} catch (err) {
		throw new ConfigError(`Invalid configuration text: ${err}`);
	}
}

export async function saveConfig(
	config: Config,
	configFile?: string,
): Promise<void> {
	const filePath = configFile ?? getConfigFile();
	const dir = filePath.substring(0, filePath.lastIndexOf("/"));
	await Bun.$`mkdir -p ${dir}`.quiet();

	// Strip undefined/null values for clean output
	const data = JSON.parse(JSON.stringify(config));

	if (filePath.toLowerCase().endsWith(".json")) {
		await Bun.write(filePath, JSON.stringify(data, null, 2));
	} else {
		const tomlStr = TOML.stringify(data as any);
		await Bun.write(filePath, tomlStr);
	}
}
