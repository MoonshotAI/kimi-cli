/**
 * Info slash-command handlers: /hooks, /mcp, /debug, /changelog
 * Corresponds to Python ui/shell/commands/info.py
 */

import type { HookEngine } from "../../../hooks/engine.ts";
import type { Config } from "../../../config.ts";
import type { Context } from "../../../soul/context.ts";
import type { ContentPart, CommandPanelConfig } from "../../../types.ts";
import { CHANGELOG } from "../../../utils/changelog.ts";
import { logger } from "../../../utils/logging.ts";

export function handleHooks(hookEngine: HookEngine): void {
  const summary = hookEngine.summary;
  if (!Object.keys(summary).length) {
    logger.info("No hooks configured. Add [[hooks]] sections to config.toml.");
    return;
  }
  logger.info("\nConfigured Hooks:");
  for (const [event, count] of Object.entries(summary)) {
    logger.info(`  ${event}: ${count} hook(s)`);
  }
  logger.info("");
}

export function handleMcp(config: Config): void {
  logger.info("MCP Configuration:");
  logger.info(`  Client timeout: ${config.mcp.client.tool_call_timeout_ms}ms`);
  logger.info("\nNote: MCP server management available via 'kimi mcp' CLI commands.");
}

export function handleDebug(context: Context): void {
  const history = context.history;
  if (!history.length) {
    logger.info("Context is empty - no messages yet.");
    return;
  }

  logger.info(`\n=== Context Debug ===`);
  logger.info(`Total messages: ${history.length}`);
  logger.info(`Token count: ${context.tokenCountWithPending}`);
  logger.info(`---`);

  for (let i = 0; i < history.length; i++) {
    const msg = history[i]!;
    const role = msg.role.toUpperCase();

    if (typeof msg.content === "string") {
      const preview =
        msg.content.length > 200
          ? msg.content.slice(0, 200) + "..."
          : msg.content;
      logger.info(`#${i + 1} [${role}] ${preview}`);
    } else if (Array.isArray(msg.content)) {
      const parts = msg.content as ContentPart[];
      const summary = parts
        .map((p: any) => {
          if (p.type === "text")
            return p.text.length > 100 ? p.text.slice(0, 100) + "..." : p.text;
          if (p.type === "tool_use") return `[tool_use: ${p.name}]`;
          if (p.type === "tool_result") return `[tool_result]`;
          if (p.type === "image") return `[image]`;
          return `[${p.type}]`;
        })
        .join(" | ");
      logger.info(`#${i + 1} [${role}] ${summary}`);
    }
  }
  logger.info(`=== End Debug ===\n`);
}

export function handleChangelog(): void {
  logger.info("\n  Release Notes:\n");
  for (const [version, entry] of Object.entries(CHANGELOG)) {
    logger.info(`  ${version}: ${entry.description}`);
    for (const item of entry.entries) {
      logger.info(`    \u2022 ${item}`);
    }
    logger.info("");
  }
}

// ── Panel factory functions ─────────────────────────────

export function createChangelogPanel(): CommandPanelConfig {
  const lines: string[] = ["  Release Notes:", ""];
  for (const [version, entry] of Object.entries(CHANGELOG)) {
    lines.push(`  ${version}: ${entry.description}`);
    for (const item of entry.entries) {
      lines.push(`    \u2022 ${item}`);
    }
    lines.push("");
  }
  return { type: "content", title: "Release Notes", content: lines.join("\n") };
}

export function createDebugPanel(context: Context): CommandPanelConfig {
  const history = context.history;
  if (!history.length) {
    return { type: "content", title: "Context Debug", content: "Context is empty - no messages yet." };
  }

  const lines: string[] = [];
  lines.push(`=== Context Debug ===`);
  lines.push(`Total messages: ${history.length}`);
  lines.push(`Token count: ${context.tokenCountWithPending}`);
  lines.push(`---`);

  for (let i = 0; i < history.length; i++) {
    const msg = history[i]!;
    const role = msg.role.toUpperCase();

    if (typeof msg.content === "string") {
      const preview =
        msg.content.length > 200
          ? msg.content.slice(0, 200) + "..."
          : msg.content;
      lines.push(`#${i + 1} [${role}] ${preview}`);
    } else if (Array.isArray(msg.content)) {
      const parts = msg.content as ContentPart[];
      const summary = parts
        .map((p: any) => {
          if (p.type === "text")
            return p.text.length > 100 ? p.text.slice(0, 100) + "..." : p.text;
          if (p.type === "tool_use") return `[tool_use: ${p.name}]`;
          if (p.type === "tool_result") return `[tool_result]`;
          if (p.type === "image") return `[image]`;
          return `[${p.type}]`;
        })
        .join(" | ");
      lines.push(`#${i + 1} [${role}] ${summary}`);
    }
  }
  lines.push(`=== End Debug ===`);
  return { type: "content", title: "Context Debug", content: lines.join("\n") };
}

export function createHooksPanel(hookEngine: HookEngine): CommandPanelConfig {
  const summary = hookEngine.summary;
  if (!Object.keys(summary).length) {
    return { type: "content", title: "Hooks", content: "No hooks configured. Add [[hooks]] sections to config.toml." };
  }
  const lines: string[] = ["Configured Hooks:"];
  for (const [event, count] of Object.entries(summary)) {
    lines.push(`  ${event}: ${count} hook(s)`);
  }
  return { type: "content", title: "Hooks", content: lines.join("\n") };
}

export function createMcpPanel(config: Config): CommandPanelConfig {
  const lines: string[] = [
    "MCP Configuration:",
    `  Client timeout: ${config.mcp.client.tool_call_timeout_ms}ms`,
    "",
    "Note: MCP server management available via 'kimi mcp' CLI commands.",
  ];
  return { type: "content", title: "MCP", content: lines.join("\n") };
}
