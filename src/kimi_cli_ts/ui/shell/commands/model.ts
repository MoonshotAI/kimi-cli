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
 * Save config with new model/thinking and trigger reload.
 * Shared by model panel and thinking panel paths.
 * Corresponds to Python ui/shell/slash.py lines 244-264.
 */
async function saveAndReload(
	config: Config,
	configMeta: ConfigMeta,
	selectedModelName: string,
	newThinking: boolean,
	currentModel: string | undefined,
	currentThinking: boolean,
	notify: Notify,
	sessionId?: string,
	onReload?: (sessionId: string, prefillText?: string) => void,
): Promise<void> {
	const selectedModelCfg = config.models[selectedModelName]!;
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
		`Switched to ${selectedModelName} with thinking ${newThinking ? "on" : "off"}. Reloading...`,
	);

	if (sessionId && onReload) {
		onReload(sessionId);
	} else if (!sessionId) {
		notify("Model", "Warning: sessionId not available for reload");
	}
}

/**
 * Create a panel for selecting thinking mode.
 * Corresponds to Python ui/shell/slash.py thinking mode selection (lines 206-228)
 */
function createThinkingModePanel(
	config: Config,
	configMeta: ConfigMeta,
	selectedModelName: string,
	currentModel: string | undefined,
	currentThinking: boolean,
	notify: Notify,
	sessionId?: string,
	onReload?: (sessionId: string, prefillText?: string) => void,
): CommandPanelConfig {
	// Build thinking mode items (matches Python lines 212-219)
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

			// Check if anything changed (matches Python lines 233-240)
			const modelChanged = currentModel !== selectedModelName;
			const thinkingChanged = currentThinking !== newThinking;

			if (!modelChanged && !thinkingChanged) {
				notify(
					"Model",
					`Already using ${selectedModelName} with thinking ${newThinking ? "on" : "off"}.`,
				);
				return;
			}

			await saveAndReload(
				config,
				configMeta,
				selectedModelName,
				newThinking,
				currentModel,
				currentThinking,
				notify,
				sessionId,
				onReload,
			);
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
				? `${modelCfg.model} (${providerName}) (current)`
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
		title: "Select a model (\u2191\u2193 navigate, Enter select, Ctrl+C cancel):",
		items,
		onSelect: async (selectedModelName: string) => {
			const selectedModelCfg = config.models[selectedModelName]!;
			const { alwaysThinking, supportsThinking } =
				getThinkingCapabilities(selectedModelCfg);

			// Step 2: Determine thinking mode (matches Python lines 206-230)
			if (alwaysThinking) {
				// always_thinking: auto-enable, save and reload
				await saveAndReload(
					config,
					configMeta,
					selectedModelName,
					true,
					currentModel,
					currentThinking,
					notify,
					sessionId,
					onReload,
				);
			} else if (supportsThinking) {
				// Model supports optional thinking — chain to thinking mode panel
				return createThinkingModePanel(
					config,
					configMeta,
					selectedModelName,
					currentModel,
					currentThinking,
					notify,
					sessionId,
					onReload,
				);
			} else {
				// Model doesn't support thinking — check if anything changed
				const modelChanged = currentModel !== selectedModelName;
				if (!modelChanged) {
					notify(
						"Model",
						`Already using ${selectedModelName} with thinking off.`,
					);
					return;
				}
				await saveAndReload(
					config,
					configMeta,
					selectedModelName,
					false,
					currentModel,
					currentThinking,
					notify,
					sessionId,
					onReload,
				);
			}
		},
	};
}
