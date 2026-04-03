import type { Config, ConfigMeta } from "../../../config.ts";
import { logger } from "../../../utils/logging.ts";

export async function handleModel(config: Config, configMeta: ConfigMeta): Promise<void> {
  if (!Object.keys(config.models).length) {
    logger.info("No models configured. Run /login to set up.");
    return;
  }

  if (!configMeta.isFromDefaultLocation) {
    logger.info("Model switching requires the default config file.");
    return;
  }

  const currentModel = config.default_model;
  logger.info("Available models:");

  const modelNames = Object.keys(config.models).sort();
  for (let i = 0; i < modelNames.length; i++) {
    const name = modelNames[i]!;
    const modelCfg = config.models[name]!;
    const providerName = modelCfg.provider;
    const current = name === currentModel ? " (current)" : "";
    const capabilities = modelCfg.capabilities?.join(", ") || "none";
    logger.info(`  [${i + 1}] ${modelCfg.model} (${providerName})${current} [${capabilities}]`);
  }

  logger.info("");
  logger.info("To switch models, use: kimi --model <model_name>");
  logger.info("Or edit ~/.kimi/config.toml and set default_model");
}
