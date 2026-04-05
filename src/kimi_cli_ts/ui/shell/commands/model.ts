import type { Config, ConfigMeta } from "../../../config.ts";
import { saveConfig } from "../../../config.ts";
import type { CommandPanelConfig } from "../../../types.ts";

type Notify = (title: string, body: string) => void;

/**
 * Determine thinking mode capabilities for a model.
 * Corresponds to Python derive_model_capabilities()
 */
function getThinkingCapabilities(modelCfg: any): {
	alwaysThinking: boolean;
	supportsThinking: boolean;
} {
	const caps = modelCfg.capabilities || [];
	return {
		alwaysThinking: caps.includes("always_thinking"),
		supportsThinking:
			caps.includes("thinking") || caps.includes("always_thinking"),
	};
}

/**
 * Handle /model when typed directly (no panel) — show current model as notification.
 */
export async function handleModel(
	config: Config,
	configMeta: ConfigMeta,
	notify?: Notify,
): Promise<void> {
	const currentModel = config.default_model;
	if (!currentModel) {
		notify?.("Model", "No model set. Use /login to configure.");
		return;
	}
	const modelCfg = config.models[currentModel];
	if (modelCfg) {
		notify?.("Model", `Current: ${modelCfg.model} (${modelCfg.provider})`);
	} else {
		notify?.("Model", `Current: ${currentModel}`);
	}
}

/**
 * Create a panel for selecting thinking mode.
 * Corresponds to Python ui/shell/slash.py thinking mode selection (lines 213-228)
 */
function createThinkingModePanel(
	config: Config,
	configMeta: ConfigMeta,
	selectedModelName: string,
	currentThinking: boolean,
	notify: Notify,
	sessionId?: string,
	onReload?: (sessionId: string, prefillText?: string) => void,
): CommandPanelConfig {
	const selectedModelCfg = config.models[selectedModelName]!;

	// Build thinking mode items
	const currentLabel = (mode: "off" | "on") =>
		mode === (currentThinking ? "on" : "off") ? ` (current)` : "";
	const items = [
		{
			label: `off${currentLabel("off")}`,
			value: "off",
			current: !currentThinking,
			description: "Disable thinking mode",
		},
		{
			label: `on${currentLabel("on")}`,
			value: "on",
			current: currentThinking,
			description: "Enable thinking mode",
		},
	];

	return {
		type: "choice",
		title: "Enable thinking mode?",
		items,
		onSelect: async (thinkingSelection: string) => {
			const newThinking = thinkingSelection === "on";

			// Check if anything changed
			if (
				selectedModelName === config.default_model &&
				newThinking === currentThinking
			) {
				notify("Model", "No changes.");
				return;
			}

			try {
				// Save config with new model and thinking setting
				const prevModel = config.default_model;
				const prevThinking = config.default_thinking;

				config.default_model = selectedModelName;
				config.default_thinking = newThinking;

				try {
					await saveConfig(config, configMeta.sourceFile ?? undefined);
				} catch (err: any) {
					// Rollback on save failure
					config.default_model = prevModel;
					config.default_thinking = prevThinking;
					notify("Model", `Failed to save config: ${err?.message ?? err}`);
					return;
				}

				// Success — show message and trigger reload
				notify(
					"Model",
					`Switched to: ${selectedModelCfg.model} with thinking ${newThinking ? "on" : "off"}. Reloading...`,
				);

				if (sessionId && onReload) {
					onReload(sessionId);
				} else if (!sessionId) {
					notify("Model", "Warning: sessionId not available for reload");
				}
				return;
			} catch (err: any) {
				notify("Model", `Error: ${err?.message ?? err}`);
			}
		},
	};
}

/**
 * Create a panel for /model that lists all available models for selection.
 * Corresponds to Python ui/shell/slash.py model() command (lines 146-264)
 */
export function createModelPanel(
	config: Config,
	configMeta: ConfigMeta,
	notify: Notify,
	sessionId?: string,
	onReload?: (sessionId: string, prefillText?: string) => void,
): CommandPanelConfig {
	const modelNames = Object.keys(config.models).sort();
	if (!modelNames.length) {
		return {
			type: "content",
			title: "Model",
			content: "No models configured. Run /login to set up.",
		};
	}

	const currentModel = config.default_model;
	const currentThinking = config.default_thinking;

	// Build model items
	const items = modelNames.map((name) => {
		const modelCfg = config.models[name]!;
		const providerName = modelCfg.provider;
		const capabilities = modelCfg.capabilities?.join(", ") || "none";
		const label =
			name === currentModel
				? `${modelCfg.model} (${providerName}) [current]`
				: `${modelCfg.model} (${providerName})`;
		return {
			label,
			value: name,
			current: name === currentModel,
			description: `caps: ${capabilities}`,
		};
	});

	return {
		type: "choice",
		title: "Select Model",
		items,
		onSelect: async (selectedModelName: string) => {
			// Step 1: Check if model changed
			if (selectedModelName === currentModel) {
				notify("Model", "Already using this model.");
				return;
			}

			// Step 2: Determine thinking mode options for selected model
			const selectedModelCfg = config.models[selectedModelName]!;
			const { alwaysThinking, supportsThinking } =
				getThinkingCapabilities(selectedModelCfg);

			// If model always has thinking, auto-enable and proceed with save
			if (alwaysThinking) {
				const newThinking = true;

				try {
					config.default_model = selectedModelName;
					config.default_thinking = newThinking;

					try {
						await saveConfig(config, configMeta.sourceFile ?? undefined);
					} catch (err: any) {
						config.default_model = currentModel;
						config.default_thinking = currentThinking;
						notify("Model", `Failed to save config: ${err?.message ?? err}`);
						return;
					}

					notify(
						"Model",
						`Switched to: ${selectedModelCfg.model} with thinking on. Reloading...`,
					);

					if (sessionId && onReload) {
						onReload(sessionId);
					} else if (!sessionId) {
						notify("Model", "Warning: sessionId not available for reload");
					}
					return;
				} catch (err: any) {
					notify("Model", `Error: ${err?.message ?? err}`);
				}
			} else if (supportsThinking) {
				// Model supports optional thinking — show thinking mode panel
				// Return the thinking mode panel to display to user
				return createThinkingModePanel(
					config,
					configMeta,
					selectedModelName,
					currentThinking,
					notify,
					sessionId,
					onReload,
				);
			} else {
				// Model doesn't support thinking
				const newThinking = false;

				try {
					config.default_model = selectedModelName;
					config.default_thinking = newThinking;

					try {
						await saveConfig(config, configMeta.sourceFile ?? undefined);
					} catch (err: any) {
						config.default_model = currentModel;
						config.default_thinking = currentThinking;
						notify("Model", `Failed to save config: ${err?.message ?? err}`);
						return;
					}

					notify(
						"Model",
						`Switched to: ${selectedModelCfg.model}. Reloading...`,
					);

					if (sessionId && onReload) {
						onReload(sessionId);
					} else if (!sessionId) {
						notify("Model", "Warning: sessionId not available for reload");
					}
					return;
				} catch (err: any) {
					notify("Model", `Error: ${err?.message ?? err}`);
				}
			}
		},
	};
}
