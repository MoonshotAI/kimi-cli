import type { Config, ConfigMeta } from "../../../config.ts";
import { saveConfig } from "../../../config.ts";
import type { CommandPanelConfig } from "../../../types.ts";

type Notify = (title: string, body: string) => void;

/**
 * Handle /model when typed directly (no panel) — show current model as notification.
 */
export async function handleModel(config: Config, configMeta: ConfigMeta, notify?: Notify): Promise<void> {
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
 * Create a panel for /model that lists all available models for selection.
 */
export function createModelPanel(config: Config, configMeta: ConfigMeta, notify: Notify): CommandPanelConfig {
  const modelNames = Object.keys(config.models).sort();
  if (!modelNames.length) {
    return {
      type: "content",
      title: "Model",
      content: "No models configured. Run /login to set up.",
    };
  }

  const currentModel = config.default_model;
  const items = modelNames.map((name) => {
    const modelCfg = config.models[name]!;
    const providerName = modelCfg.provider;
    const capabilities = modelCfg.capabilities?.join(", ") || "none";
    return {
      label: `${modelCfg.model} (${providerName})`,
      value: name,
      current: name === currentModel,
      description: `caps: ${capabilities}`,
    };
  });

  return {
    type: "choice",
    title: "Select Model",
    items,
    onSelect: async (value: string) => {
      if (value === currentModel) {
        notify("Model", "Already using this model.");
        return;
      }
      config.default_model = value;
      try {
        await saveConfig(config, configMeta.sourceFile ?? undefined);
        const modelCfg = config.models[value];
        notify("Model", `Switched to: ${modelCfg?.model ?? value}. Restart to apply.`);
      } catch (err: any) {
        notify("Model", `Failed to save: ${err?.message ?? err}`);
      }
    },
  };
}
