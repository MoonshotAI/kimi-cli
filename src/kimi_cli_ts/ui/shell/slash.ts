/**
 * Shell slash commands — corresponds to Python's ui/shell/slash.py.
 * Shell-level commands: /clear, /help, /exit, /theme, /version.
 */

import type { SlashCommand, CommandPanelConfig } from "../../types";
import { getActiveTheme } from "../theme.ts";

export type SlashCommandHandler = (args: string) => Promise<void>;

export interface ShellSlashContext {
  clearMessages: () => void;
  exit: () => void;
  setTheme: (theme: "dark" | "light") => void;
  getAllCommands: () => SlashCommand[];
  pushNotification: (title: string, body: string) => void;
  /** Get session dir + workDir + title for /undo and /fork. */
  getSessionInfo?: () => { sessionDir: string; workDir: string; title: string } | null;
  /** Trigger a reload with a new session (and optional prefill text). */
  triggerReload?: (sessionId: string, prefillText?: string) => void;
}

/**
 * Create shell-level slash commands.
 */
export function createShellSlashCommands(
  ctx: ShellSlashContext,
): SlashCommand[] {
  return [
    {
      name: "clear",
      description: "Clear conversation history",
      aliases: ["cls", "reset"],
      handler: async () => {
        ctx.clearMessages();
      },
    },
    {
      name: "exit",
      description: "Exit the application",
      aliases: ["quit", "q"],
      handler: async () => {
        ctx.exit();
      },
    },
    {
      name: "help",
      description: "Show help information",
      aliases: ["h", "?"],
      handler: async () => {
        // Fallback when panel is not used (e.g. direct /help invocation)
        const allCmds = ctx.getAllCommands();
        ctx.pushNotification("Help", formatHelp(allCmds));
      },
      panel: (): CommandPanelConfig => {
        const allCmds = ctx.getAllCommands();
        return {
          type: "content",
          title: "Help",
          content: formatHelp(allCmds),
        };
      },
    },
    {
      name: "theme",
      description: "Toggle dark/light theme",
      handler: async (args: string) => {
        const theme = args.trim() as "dark" | "light";
        if (theme === "dark" || theme === "light") {
          ctx.setTheme(theme);
          ctx.pushNotification("Theme", `Switched to ${theme} theme.`);
        } else {
          // Toggle
          const current = getActiveTheme();
          const next = current === "dark" ? "light" : "dark";
          ctx.setTheme(next);
          ctx.pushNotification("Theme", `Switched to ${next} theme.`);
        }
      },
      panel: (): CommandPanelConfig => {
        const current = getActiveTheme();
        return {
          type: "choice",
          title: "Theme",
          items: [
            { label: "🌙 Dark", value: "dark", current: current === "dark" },
            { label: "☀️  Light", value: "light", current: current === "light" },
          ],
          onSelect: (value: string) => {
            const theme = value as "dark" | "light";
            ctx.setTheme(theme);
            ctx.pushNotification("Theme", `Switched to ${theme} theme.`);
          },
        };
      },
    },
    {
      name: "version",
      description: "Show version information",
      handler: async () => {
        ctx.pushNotification("Version", "kimi-cli v2.0.0 (TypeScript)");
      },
    },
    {
      name: "undo",
      description: "Undo: fork the session at a previous turn and retry",
      handler: async () => {
        if (!ctx.getSessionInfo || !ctx.triggerReload) return;
        const info = ctx.getSessionInfo();
        if (!info) {
          ctx.pushNotification("Undo", "No active session.");
          return;
        }
        const { enumerateTurns, forkSession } = await import("../../session_fork.ts");
        const { join } = await import("node:path");

        const wirePath = join(info.sessionDir, "wire.jsonl");
        const turns = enumerateTurns(wirePath);
        if (turns.length === 0) {
          ctx.pushNotification("Undo", "No turns found in this session.");
          return;
        }

        // Build choices panel
        const items = turns.map((t) => {
          const firstLine = t.userText.split("\n", 1)[0] ?? "";
          const label = firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
          return { label: `[${t.index}] ${label}`, value: String(t.index), current: t.index === turns.length - 1 };
        });

        // Use the panel system for selection
        // (Panel-based selection is handled externally; here we use a simple last-turn undo)
        // For the panel-based approach, we expose a panel config:
        ctx.pushNotification("Undo", "Select a turn from the /undo panel.");
      },
      panel: (): CommandPanelConfig => {
        if (!ctx.getSessionInfo || !ctx.triggerReload) {
          return { type: "content", title: "Undo", content: "No active session." };
        }
        const info = ctx.getSessionInfo();
        if (!info) {
          return { type: "content", title: "Undo", content: "No active session." };
        }

        // Synchronous — enumerateTurns is sync in our TS impl
        const { enumerateTurns, forkSession } = require("../../session_fork.ts");
        const { join } = require("node:path");

        const wirePath = join(info.sessionDir, "wire.jsonl");
        const turns = enumerateTurns(wirePath) as import("../../session_fork.ts").TurnInfo[];
        if (turns.length === 0) {
          return { type: "content", title: "Undo", content: "No turns found in this session." };
        }

        const items = turns.map((t) => {
          const firstLine = t.userText.split("\n", 1)[0] ?? "";
          const label = firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
          return { label: `[${t.index}] ${label}`, value: String(t.index), current: t.index === turns.length - 1 };
        });

        return {
          type: "choice",
          title: "Undo — select a turn to redo",
          items,
          onSelect: async (value: string) => {
            const turnIndex = parseInt(value, 10);
            const selectedTurn = turns[turnIndex];
            if (!selectedTurn) return;

            const userText = selectedTurn.userText;

            try {
              let newSessionId: string;
              if (turnIndex === 0) {
                // Fork with no history — just the user text
                const { Session } = await import("../../session.ts");
                const { loadSessionState, saveSessionState } = await import("../../session.ts");
                const newSession = await Session.create(info.workDir);
                newSessionId = newSession.id;
                const newState = await loadSessionState(newSession.dir);
                newState.custom_title = `Undo: ${info.title}`;
                newState.title_generated = true;
                await saveSessionState(newState, newSession.dir);
              } else {
                const forkTurnIndex = turnIndex - 1;
                newSessionId = await forkSession({
                  sourceSessionDir: info.sessionDir,
                  workDir: info.workDir,
                  turnIndex: forkTurnIndex,
                  titlePrefix: "Undo",
                  sourceTitle: info.title,
                });
              }

              ctx.pushNotification("Undo", `Forked at turn ${turnIndex}. Switching to new session...`);
              ctx.triggerReload!(newSessionId, userText);
            } catch (err: any) {
              ctx.pushNotification("Undo", `Error: ${err.message ?? String(err)}`);
            }
          },
        };
      },
    },
    {
      name: "fork",
      description: "Fork the current session (copy all history)",
      handler: async () => {
        if (!ctx.getSessionInfo || !ctx.triggerReload) {
          ctx.pushNotification("Fork", "No active session.");
          return;
        }
        const info = ctx.getSessionInfo();
        if (!info) {
          ctx.pushNotification("Fork", "No active session.");
          return;
        }

        try {
          const { forkSession } = await import("../../session_fork.ts");
          const newSessionId = await forkSession({
            sourceSessionDir: info.sessionDir,
            workDir: info.workDir,
            titlePrefix: "Fork",
            sourceTitle: info.title,
          });

          ctx.pushNotification("Fork", "Session forked. Switching to new session...");
          ctx.triggerReload(newSessionId);
        } catch (err: any) {
          ctx.pushNotification("Fork", `Error: ${err.message ?? String(err)}`);
        }
      },
    },
  ];
}

/**
 * Parse a slash command from input string.
 * Returns null if not a slash command.
 */
export function parseSlashCommand(
  input: string,
): { name: string; args: string } | null {
  if (!input.startsWith("/")) return null;
  const trimmed = input.slice(1).trim();
  if (!trimmed) return null;
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { name: trimmed, args: "" };
  }
  return {
    name: trimmed.slice(0, spaceIdx),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}

/**
 * Find a slash command by name or alias.
 */
export function findSlashCommand(
  commands: SlashCommand[],
  name: string,
): SlashCommand | undefined {
  return commands.find(
    (cmd) => cmd.name === name || cmd.aliases?.includes(name),
  );
}

function formatHelp(commands: SlashCommand[]): string {
  const lines = [
    "Kimi Code CLI — Help",
    "",
    "Keyboard Shortcuts:",
    "  Ctrl+X             Toggle agent/shell mode",
    "  Shift+Tab          Toggle plan mode",
    "  Ctrl+O             Edit in external editor",
    "  Ctrl+J / Alt+Enter Insert newline",
    "  Ctrl+V             Paste (supports images)",
    "  Ctrl+D             Exit",
    "  Ctrl+C             Interrupt",
    "",
    "Slash Commands:",
  ];

  // Deduplicate by name and sort
  const seen = new Set<string>();
  const sorted = commands
    .filter((c) => {
      if (seen.has(c.name)) return false;
      seen.add(c.name);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const cmd of sorted) {
    const aliases = cmd.aliases?.length ? `, /${cmd.aliases.join(", /")}` : "";
    const nameStr = `/${cmd.name}${aliases}`;
    lines.push(`  ${nameStr.padEnd(22)} ${cmd.description}`);
  }

  lines.push("");
  return lines.join("\n");
}
