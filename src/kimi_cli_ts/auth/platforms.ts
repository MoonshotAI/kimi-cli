/**
 * Platform definitions and model management.
 * Corresponds to Python's auth/platforms.py.
 */

import type { Config, OAuthRef } from "../config.ts";
import type { ModelCapability } from "../types.ts";
import { logger } from "../utils/logging.ts";

// ── Constants ────────────────────────────────────────────

export const KIMI_CODE_PLATFORM_ID = "kimi-code";
export const MANAGED_PROVIDER_PREFIX = "managed:";

// ── Types ────────────────────────────────────────────────

export interface ModelInfo {
	id: string;
	contextLength: number;
	supportsReasoning: boolean;
	supportsImageIn: boolean;
	supportsVideoIn: boolean;
}

export function deriveModelCapabilities(model: ModelInfo): Set<string> {
	const caps = new Set<string>();
	if (model.supportsReasoning) caps.add("thinking");
	if (model.id.toLowerCase().includes("thinking")) {
		caps.add("thinking");
		caps.add("always_thinking");
	}
	if (model.supportsImageIn) caps.add("image_in");
	if (model.supportsVideoIn) caps.add("video_in");
	if (model.id.toLowerCase().includes("kimi-k2.5")) {
		caps.add("thinking");
		caps.add("image_in");
		caps.add("video_in");
	}
	return caps;
}

export interface Platform {
	id: string;
	name: string;
	baseUrl: string;
	searchUrl?: string;
	fetchUrl?: string;
	allowedPrefixes?: string[];
}

// ── Platform registry ────────────────────────────────────

function kimiCodeBaseUrl(): string {
	return process.env.KIMI_CODE_BASE_URL ?? "https://api.kimi.com/coding/v1";
}

export const PLATFORMS: Platform[] = [
	{
		id: KIMI_CODE_PLATFORM_ID,
		name: "Kimi Code",
		baseUrl: kimiCodeBaseUrl(),
		searchUrl: `${kimiCodeBaseUrl()}/search`,
		fetchUrl: `${kimiCodeBaseUrl()}/fetch`,
	},
	{
		id: "moonshot-cn",
		name: "Moonshot AI Open Platform (moonshot.cn)",
		baseUrl: "https://api.moonshot.cn/v1",
		allowedPrefixes: ["kimi-k"],
	},
	{
		id: "moonshot-ai",
		name: "Moonshot AI Open Platform (moonshot.ai)",
		baseUrl: "https://api.moonshot.ai/v1",
		allowedPrefixes: ["kimi-k"],
	},
];

const _platformById = new Map(PLATFORMS.map((p) => [p.id, p]));
const _platformByName = new Map(PLATFORMS.map((p) => [p.name, p]));

export function getPlatformById(platformId: string): Platform | undefined {
	return _platformById.get(platformId);
}

export function getPlatformByName(name: string): Platform | undefined {
	return _platformByName.get(name);
}

// ── Key helpers ──────────────────────────────────────────

export function managedProviderKey(platformId: string): string {
	return `${MANAGED_PROVIDER_PREFIX}${platformId}`;
}

export function managedModelKey(platformId: string, modelId: string): string {
	return `${platformId}/${modelId}`;
}

export function parseManagedProviderKey(providerKey: string): string | null {
	if (!providerKey.startsWith(MANAGED_PROVIDER_PREFIX)) return null;
	return providerKey.slice(MANAGED_PROVIDER_PREFIX.length);
}

export function isManagedProviderKey(providerKey: string): boolean {
	return providerKey.startsWith(MANAGED_PROVIDER_PREFIX);
}

export function getPlatformNameForProvider(providerKey: string): string | null {
	const platformId = parseManagedProviderKey(providerKey);
	if (!platformId) return null;
	const platform = getPlatformById(platformId);
	return platform?.name ?? null;
}

// ── Model listing ────────────────────────────────────────

export async function listModels(
	platform: Platform,
	apiKey: string,
): Promise<ModelInfo[]> {
	const modelsUrl = `${platform.baseUrl.replace(/\/+$/, "")}/models`;
	const res = await fetch(modelsUrl, {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (!res.ok) {
		throw new Error(`Failed to list models (HTTP ${res.status})`);
	}
	const json = (await res.json()) as { data?: unknown[] };
	const data = json.data;
	if (!Array.isArray(data)) {
		throw new Error(`Unexpected models response for ${platform.baseUrl}`);
	}

	const models: ModelInfo[] = [];
	for (const item of data as Record<string, unknown>[]) {
		const modelId = item.id;
		if (!modelId) continue;
		models.push({
			id: String(modelId),
			contextLength: Number(item.context_length ?? 0),
			supportsReasoning: Boolean(item.supports_reasoning),
			supportsImageIn: Boolean(item.supports_image_in),
			supportsVideoIn: Boolean(item.supports_video_in),
		});
	}

	if (platform.allowedPrefixes) {
		const prefixes = platform.allowedPrefixes;
		return models.filter((m) => prefixes.some((p) => m.id.startsWith(p)));
	}
	return models;
}

// ── Refresh managed models ───────────────────────────────

export async function refreshManagedModels(config: Config): Promise<boolean> {
	// Lazy import to avoid circular dependency (oauth.ts imports from platforms.ts)
	const { loadTokens } = await import("./oauth.ts");

	let changed = false;
	for (const [providerKey, provider] of Object.entries(config.providers)) {
		const platformId = parseManagedProviderKey(providerKey);
		if (!platformId) continue;
		const platform = getPlatformById(platformId);
		if (!platform) continue;

		let apiKey = provider.api_key;
		if (!apiKey && provider.oauth) {
			const token = await loadTokens(provider.oauth);
			if (token) apiKey = token.access_token;
		}
		if (!apiKey) continue;

		try {
			const models = await listModels(platform, apiKey);
			if (applyModels(config, providerKey, platformId, models)) {
				changed = true;
			}
		} catch (err) {
			logger.error(`Failed to refresh models for ${platformId}: ${err}`);
		}
	}
	return changed;
}

function applyModels(
	config: Config,
	providerKey: string,
	platformId: string,
	models: ModelInfo[],
): boolean {
	let changed = false;
	const modelKeys = new Set<string>();

	for (const model of models) {
		const modelKey = managedModelKey(platformId, model.id);
		modelKeys.add(modelKey);

		const existing = config.models[modelKey];
		const capabilities = deriveModelCapabilities(model);
		const capsArray =
			capabilities.size > 0
				? ([...capabilities] as ModelCapability[])
				: undefined;

		if (!existing) {
			config.models[modelKey] = {
				provider: providerKey,
				model: model.id,
				max_context_size: model.contextLength,
				capabilities: capsArray,
			};
			changed = true;
			continue;
		}

		if (existing.provider !== providerKey) {
			existing.provider = providerKey;
			changed = true;
		}
	}

	// Remove stale models
	for (const [key, model] of Object.entries(config.models)) {
		if (model.provider !== providerKey) continue;
		if (modelKeys.has(key)) continue;
		delete config.models[key];
		if (config.default_model === key) {
			config.default_model = "";
		}
		changed = true;
	}

	return changed;
}
