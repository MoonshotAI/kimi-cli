import { loadConfig, saveConfig, type Config, type ConfigMeta } from "../../../config.ts";
import type { CommandPanelConfig } from "../../../types.ts";
import { logger } from "../../../utils/logging.ts";
import { which } from "bun";

type Notify = (title: string, body: string) => void;

export function createEditorPanel(config: Config, configMeta: ConfigMeta, notify: Notify): CommandPanelConfig {
  const current = config.default_editor || "";
  return {
    type: "choice",
    title: "Select Editor",
    items: [
      { label: "VS Code (code --wait)", value: "code --wait", current: current === "code --wait" },
      { label: "Vim", value: "vim", current: current === "vim" },
      { label: "Nano", value: "nano", current: current === "nano" },
      { label: "Auto-detect ($VISUAL/$EDITOR)", value: "", current: !current },
    ],
    onSelect: (value: string) => {
      // Save to config
      try {
        config.default_editor = value;
        saveConfig(config, configMeta.sourceFile ?? undefined);
        notify("Editor", `Editor set to: ${value || "auto-detect"}`);
      } catch (err: any) {
        notify("Editor", `Failed to save: ${err?.message ?? err}`);
      }
    },
  };
}

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
