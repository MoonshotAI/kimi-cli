/**
 * /login and /logout slash command handlers.
 * Corresponds to Python's ui/shell/oauth.py + setup.py.
 *
 * /login uses a multi-level panel flow:
 * 1. Select platform (choice)
 * 2a. Kimi Code → OAuth device-code flow (events shown in message list)
 * 2b. Others → Enter API key (input) → Select model (choice) → Thinking (choice)
 */

import { loginKimiCode, logoutKimiCode } from "../../../auth/oauth.ts";
import {
	PLATFORMS,
	KIMI_CODE_PLATFORM_ID,
	getPlatformById,
	managedProviderKey,
	managedModelKey,
	listModels,
	deriveModelCapabilities,
	type Platform,
	type ModelInfo,
} from "../../../auth/platforms.ts";
import { saveConfig, type Config } from "../../../config.ts";
import type { CommandPanelConfig } from "../../../types.ts";

type Notify = (title: string, body: string) => void;

// ── Kimi Code OAuth login (via async generator) ──────────

async function runLoginKimiCode(config: Config, notify: Notify): Promise<void> {
	for await (const event of loginKimiCode(config)) {
		switch (event.type) {
			case "info":
			case "verification_url":
			case "waiting":
				notify("Login", event.message);
				break;
			case "success":
				notify("Login", `✓ ${event.message}`);
				break;
			case "error":
				notify("Login", `✗ ${event.message}`);
				break;
		}
	}
}

// ── Non-OAuth platform setup (multi-step wizard) ─────────

/**
 * Step 2: After API key entered, verify it and show model selection.
 */
function buildModelSelectPanel(
	platform: Platform,
	apiKey: string,
	config: Config,
	notify: Notify,
): CommandPanelConfig {
	// We return a content panel first as "loading", then transition
	return {
		type: "content",
		title: `${platform.name} — Verifying API key...`,
		content: "Fetching available models, please wait...",
	};
}

/**
 * Actually fetch models and build the model choice panel.
 */
async function fetchAndBuildModelPanel(
	platform: Platform,
	apiKey: string,
	config: Config,
	notify: Notify,
): Promise<CommandPanelConfig | void> {
	let models: ModelInfo[];
	try {
		models = await listModels(platform, apiKey);
	} catch (err: any) {
		if (err?.message?.includes("401")) {
			notify("Login", `✗ API key verification failed. Please check your key.`);
		} else {
			notify("Login", `✗ Failed to fetch models: ${err?.message ?? err}`);
		}
		return;
	}

	if (!models.length) {
		notify("Login", "✗ No models available for this platform.");
		return;
	}

	return {
		type: "choice",
		title: `${platform.name} — Select Model`,
		items: models.map((m) => ({
			label: m.id,
			value: m.id,
			description: `ctx: ${m.contextLength}`,
		})),
		onSelect: (modelId: string): CommandPanelConfig | void => {
			const model = models.find((m) => m.id === modelId);
			if (!model) return;
			const caps = deriveModelCapabilities(model);

			// If model supports optional thinking, ask
			if (caps.has("thinking") && !caps.has("always_thinking")) {
				return buildThinkingPanel(
					platform,
					apiKey,
					model,
					models,
					config,
					notify,
				);
			}
			// Otherwise, auto-decide
			const thinking = caps.has("always_thinking") || caps.has("thinking");
			applyNonOAuthConfig(
				platform,
				apiKey,
				model,
				models,
				thinking,
				config,
				notify,
			);
		},
	};
}

/**
 * Step 3: Select thinking mode.
 */
function buildThinkingPanel(
	platform: Platform,
	apiKey: string,
	selectedModel: ModelInfo,
	models: ModelInfo[],
	config: Config,
	notify: Notify,
): CommandPanelConfig {
	return {
		type: "choice",
		title: `${platform.name} — Thinking Mode`,
		items: [
			{ label: "On", value: "on", description: "Enable extended thinking" },
			{ label: "Off", value: "off", description: "Standard mode" },
		],
		onSelect: (value: string) => {
			const thinking = value === "on";
			applyNonOAuthConfig(
				platform,
				apiKey,
				selectedModel,
				models,
				thinking,
				config,
				notify,
			);
		},
	};
}

/**
 * Apply config for non-OAuth platforms (API key based).
 * Corresponds to Python's _apply_setup_result().
 */
function applyNonOAuthConfig(
	platform: Platform,
	apiKey: string,
	selectedModel: ModelInfo,
	models: ModelInfo[],
	thinking: boolean,
	config: Config,
	notify: Notify,
): void {
	const providerKey = managedProviderKey(platform.id);

	config.providers[providerKey] = {
		type: "kimi",
		base_url: platform.baseUrl,
		api_key: apiKey,
	};

	// Remove old models for this provider
	for (const [key, model] of Object.entries(config.models)) {
		if (model.provider === providerKey) delete config.models[key];
	}

	// Add all available models
	for (const m of models) {
		const caps = deriveModelCapabilities(m);
		config.models[managedModelKey(platform.id, m.id)] = {
			provider: providerKey,
			model: m.id,
			max_context_size: m.contextLength,
			capabilities: caps.size > 0 ? ([...caps] as any) : undefined,
		};
	}

	config.default_model = managedModelKey(platform.id, selectedModel.id);
	config.default_thinking = thinking;

	if (platform.searchUrl) {
		config.services = config.services ?? {};
		(config.services as any).moonshot_search = {
			base_url: platform.searchUrl,
			api_key: apiKey,
		};
	}
	if (platform.fetchUrl) {
		config.services = config.services ?? {};
		(config.services as any).moonshot_fetch = {
			base_url: platform.fetchUrl,
			api_key: apiKey,
		};
	}

	saveConfig(config)
		.then(() => {
			const thinkLabel = thinking ? "on" : "off";
			notify(
				"Login",
				[
					`✓ Setup complete!`,
					`  Platform: ${platform.name}`,
					`  Model:    ${selectedModel.id}`,
					`  Thinking: ${thinkLabel}`,
				].join("\n"),
			);
		})
		.catch((err) => {
			notify("Login", `✗ Failed to save config: ${err}`);
		});
}

// ── Public API ───────────────────────────────────────────

/**
 * Handle /login — dispatches to the correct flow based on platform.
 * When called without a panel (e.g. `/login` typed directly), defaults to Kimi Code.
 */
export async function handleLogin(
	config: Config,
	notify: Notify,
): Promise<void> {
	await runLoginKimiCode(config, notify);
}

/**
 * Handle /logout — delete stored OAuth tokens and clean up config.
 */
export async function handleLogout(
	config: Config,
	notify: Notify,
): Promise<void> {
	for await (const event of logoutKimiCode(config)) {
		switch (event.type) {
			case "success":
				notify("Logout", `✓ ${event.message}`);
				break;
			case "error":
				notify("Logout", `✗ ${event.message}`);
				break;
			default:
				notify("Logout", event.message);
		}
	}
}

/**
 * Create panel config for /login — platform selection → multi-step wizard.
 * Corresponds to Python's select_platform() → setup_platform().
 */
export function createLoginPanel(
	config: Config,
	notify: Notify,
): CommandPanelConfig {
	return {
		type: "choice",
		title: "Login — Select Platform",
		items: PLATFORMS.map((p) => ({
			label: p.name,
			value: p.id,
		})),
		onSelect: (
			platformId: string,
		): CommandPanelConfig | Promise<CommandPanelConfig | void> | void => {
			const platform = getPlatformById(platformId);
			if (!platform) return;

			if (platform.id === KIMI_CODE_PLATFORM_ID) {
				// Kimi Code uses OAuth — events go to message list
				runLoginKimiCode(config, notify);
				return; // Close panel, events stream into chat
			}

			// Other platforms: multi-step wizard
			return {
				type: "input",
				title: `${platform.name} — Enter API Key`,
				placeholder: "Paste your API key here...",
				password: true,
				onSubmit: (apiKey: string): Promise<CommandPanelConfig | void> => {
					return fetchAndBuildModelPanel(platform, apiKey, config, notify);
				},
			};
		},
	};
}
