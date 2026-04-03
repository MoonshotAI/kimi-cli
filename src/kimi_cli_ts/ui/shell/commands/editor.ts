import { loadConfig, saveConfig, type Config, type ConfigMeta } from "../../../config.ts";
import { logger } from "../../../utils/logging.ts";
import { which } from "bun";

export async function handleEditor(config: Config, configMeta: ConfigMeta, args: string): Promise<void> {
  const currentEditor = config.default_editor;

  if (!args.trim()) {
    // Show current and available options
    logger.info(`Current editor: ${currentEditor || "auto-detect"}`);
    logger.info("");
    logger.info("Available editors:");
    logger.info("  /editor code --wait   (VS Code)");
    logger.info("  /editor vim");
    logger.info("  /editor nano");
    logger.info("  /editor <command>     (any editor command)");
    logger.info('  /editor ""            (auto-detect from $VISUAL/$EDITOR)');
    return;
  }

  const newEditor = args.trim();

  // Validate binary exists
  if (newEditor) {
    const binary = newEditor.split(/\s+/)[0]!;
    const found = which(binary);
    if (!found) {
      logger.info(`Warning: '${binary}' not found in PATH. Saving anyway.`);
    }
  }

  if (newEditor === currentEditor) {
    logger.info(`Editor is already set to: ${newEditor || "auto-detect"}`);
    return;
  }

  // Save to config
  try {
    const freshConfig = (await loadConfig(configMeta.sourceFile ?? undefined)).config;
    freshConfig.default_editor = newEditor;
    await saveConfig(freshConfig, configMeta.sourceFile ?? undefined);
    config.default_editor = newEditor;
    logger.info(`Editor set to: ${newEditor || "auto-detect"}`);
  } catch (err) {
    logger.info(`Failed to save config: ${err instanceof Error ? err.message : err}`);
  }
}
