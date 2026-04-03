/**
 * Shell.tsx — Main REPL component.
 * Corresponds to Python's ui/shell/__init__.py.
 *
 * Layout logic:
 * - WelcomeBox: fixed at top (will scroll off when content grows)
 * - ChatList: height = content lines (grows as messages added)
 * - InputBox: flexGrow=1 + minHeight=6, fills remaining space
 *   - text starts from top (row 0)
 *   - when ChatList grows, InputBox shrinks down to minHeight
 *   - when InputBox is at minHeight, total layout exceeds screen → scrollable
 * - StatusBar: always at bottom
 */

import React, { useCallback, useEffect, useState, useRef } from "react";
import { Box, useApp, useStdout } from "ink";
import { MessageList } from "./Visualize.tsx";
import { Prompt } from "./Prompt.tsx";
import { WelcomeBox } from "../components/WelcomeBox.tsx";
import { StatusBar } from "../components/StatusBar.tsx";
import { ApprovalPrompt } from "../components/ApprovalPrompt.tsx";
import { CommandPanel } from "../components/CommandPanel.tsx";
import { useGitStatus } from "../hooks/useGitStatus.ts";
import { StreamingSpinner, CompactionSpinner } from "../components/Spinner.tsx";
import { useWire } from "../hooks/useWire.ts";
import {
  createShellSlashCommands,
  parseSlashCommand,
  findSlashCommand,
} from "./slash.ts";
import { setActiveTheme } from "../theme.ts";
import type { WireUIEvent } from "./events.ts";
import type { KeyAction } from "./keyboard.ts";
import type { ApprovalResponseKind } from "../../wire/types.ts";
import type { SlashCommand, CommandPanelConfig } from "../../types.ts";

import { tmpdir } from "node:os";
import { join } from "node:path";

const INPUT_MIN_HEIGHT = 6;

/**
 * Run a shell command in foreground (matches Python _run_shell_command).
 */
async function runShellCommand(
  command: string,
  pushNotification: (title: string, body: string) => void,
): Promise<void> {
  const trimmed = command.trim();
  if (!trimmed) return;

  // Block 'cd' — directory changes don't persist
  const parts = trimmed.split(/\s+/);
  if (parts[0] === "cd") {
    pushNotification("Shell", "Warning: Directory changes are not preserved across command executions.");
    return;
  }

  try {
    const proc = Bun.spawn(["sh", "-c", trimmed], {
      stdio: ["inherit", "inherit", "inherit"],
      env: process.env,
    });
    await proc.exited;
  } catch (err: any) {
    pushNotification("Shell", `Failed to run command: ${err?.message ?? err}`);
  }
}

/**
 * Open $VISUAL / $EDITOR / vim to compose multi-line input.
 * After the editor exits, submit the content.
 */
async function openExternalEditor(
  pushNotification: (title: string, body: string) => void,
  onSubmit?: (input: string) => void,
): Promise<void> {
  const editor = process.env.VISUAL || process.env.EDITOR || "vim";
  const tmpFile = join(tmpdir(), `kimi-input-${Date.now()}.md`);

  try {
    await Bun.write(tmpFile, "");

    const proc = Bun.spawn(editor.split(/\s+/).concat(tmpFile), {
      stdio: ["inherit", "inherit", "inherit"],
    });
    const code = await proc.exited;

    if (code !== 0) {
      pushNotification("Editor", `Editor exited with code ${code}`);
      return;
    }

    const content = await Bun.file(tmpFile).text();
    const trimmed = content.trim();
    if (trimmed && onSubmit) {
      onSubmit(trimmed);
    } else if (!trimmed) {
      pushNotification("Editor", "Empty input, nothing submitted.");
    }
  } catch (err: any) {
    pushNotification("Editor", `Failed to open editor: ${err?.message ?? err}`);
  } finally {
    try {
      const fs = require("node:fs");
      fs.unlinkSync(tmpFile);
    } catch { /* ignore */ }
  }
}

/** Deduplicate commands by name, shell commands take priority */
function deduplicateCommands(commands: SlashCommand[]): SlashCommand[] {
  const seen = new Map<string, SlashCommand>();
  for (const cmd of commands) {
    if (!seen.has(cmd.name)) {
      seen.set(cmd.name, cmd);
    }
  }
  return [...seen.values()];
}

export interface ShellProps {
  modelName?: string;
  workDir?: string;
  sessionId?: string;
  sessionDir?: string;
  sessionTitle?: string;
  thinking?: boolean;
  prefillText?: string;
  onSubmit?: (input: string) => void;
  onInterrupt?: () => void;
  onPlanModeToggle?: () => Promise<boolean>;
  onApprovalResponse?: (
    requestId: string,
    decision: ApprovalResponseKind,
    feedback?: string,
  ) => void;
  onWireReady?: (pushEvent: (event: WireUIEvent) => void) => void;
  onReload?: (sessionId: string, prefillText?: string) => void;
  extraSlashCommands?: SlashCommand[];
}

export function Shell({
  modelName = "",
  workDir,
  sessionId,
  sessionDir,
  sessionTitle,
  thinking = false,
  prefillText,
  onSubmit,
  onInterrupt,
  onPlanModeToggle,
  onApprovalResponse,
  onWireReady,
  onReload,
  extraSlashCommands = [],
}: ShellProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [termHeight, setTermHeight] = useState(stdout?.rows || 24);
  const [slashMenuVisible, setSlashMenuVisible] = useState(false);
  const [activePanel, setActivePanel] = useState<CommandPanelConfig | null>(null);
  const [clearInputSignal, setClearInputSignal] = useState(0);
  const [shellMode, setShellMode] = useState(false);

  // Ctrl+C / Esc double-press tracking (moved from keyboard.ts)
  const ctrlCCount = useRef(0);
  const ctrlCTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const escCount = useRef(0);
  const escTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const CTRLC_WINDOW = 2000;
  const ESC_WINDOW = 500;

  // Wire state
  const wire = useWire({ onReady: onWireReady });

  // Git status
  const gitStatus = useGitStatus();

  // Helper to push notifications to notification stack
  const pushNotification = useCallback(
    (title: string, body: string) => {
      wire.pushEvent({ type: "notification", title, body });
    },
    [wire],
  );

  // Shell slash commands
  const shellCommands = createShellSlashCommands({
    clearMessages: wire.clearMessages,
    exit: () => exit(),
    setTheme: (theme) => setActiveTheme(theme),
    getAllCommands: () => allCommands,
    pushNotification,
    getSessionInfo: () => {
      if (!sessionDir || !workDir) return null;
      return { sessionDir, workDir, title: sessionTitle ?? "Untitled" };
    },
    triggerReload: (newSessionId: string, prefill?: string) => {
      onReload?.(newSessionId, prefill);
    },
  });

  const allCommands = deduplicateCommands([
    ...shellCommands,
    ...extraSlashCommands,
  ]);

  // Handle terminal resize
  useEffect(() => {
    const onResize = () => setTermHeight(stdout?.rows || 24);
    stdout?.on("resize", onResize);
    return () => {
      stdout?.off("resize", onResize);
    };
  }, [stdout]);

  // Handle actions from Prompt's unified useInput
  const handleAction = useCallback(
    (action: KeyAction) => {
      // Reset the OTHER counter on any action
      if (action === "interrupt") {
        // Could be Ctrl+C or Esc — we track both the same way now.
        // Check Ctrl+C double-press for exit
        ctrlCCount.current += 1;
        if (ctrlCCount.current >= 2) {
          ctrlCCount.current = 0;
          if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
          exit();
          return;
        }
        if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
        ctrlCTimer.current = setTimeout(() => {
          ctrlCCount.current = 0;
        }, CTRLC_WINDOW);

        // Do the interrupt
        if (activePanel) {
          setActivePanel(null);
        } else if (wire.isStreaming) {
          onInterrupt?.();
          wire.pushEvent({ type: "error", message: "Interrupted by user" });
        }
        pushNotification("Ctrl-C", "Press Ctrl-C again to exit");
        return;
      }

      // Any non-interrupt action resets Ctrl+C counter
      ctrlCCount.current = 0;

      switch (action) {
        case "clear-input":
          setClearInputSignal((n) => n + 1);
          break;
        case "toggle-plan-mode":
          if (onPlanModeToggle) {
            onPlanModeToggle()
              .then((newState) => {
                pushNotification(
                  "Plan mode",
                  newState ? "Plan mode ON" : "Plan mode OFF",
                );
              })
              .catch((err: unknown) => {
                pushNotification("Plan mode", `Error: ${String(err)}`);
              });
          }
          break;
        case "toggle-shell-mode":
          setShellMode((prev) => {
            const next = !prev;
            pushNotification("Mode", next ? "Shell mode" : "Agent mode");
            return next;
          });
          break;
        case "open-editor":
          openExternalEditor(pushNotification, onSubmit);
          break;
      }
    },
    [activePanel, wire, onInterrupt, onPlanModeToggle, onSubmit, pushNotification, exit],
  );

  // Slash commands allowed in shell mode
  const SHELL_MODE_COMMANDS = new Set(["clear", "exit", "help", "theme", "version", "quit", "q", "cls", "reset", "h", "?"]);

  // Handle user input
  const handleSubmit = useCallback(
    (input: string) => {
      const parsed = parseSlashCommand(input);
      if (parsed) {
        // In shell mode, only allow a subset of slash commands
        if (shellMode) {
          if (!SHELL_MODE_COMMANDS.has(parsed.name)) {
            wire.pushEvent({
              type: "notification",
              title: "Shell mode",
              body: `/${parsed.name} is not available in shell mode. Press Ctrl-X to switch to agent mode.`,
            });
            return;
          }
        }
        const cmd = findSlashCommand(allCommands, parsed.name);
        if (cmd) {
          if (cmd.panel && !parsed.args) {
            const panelConfig = cmd.panel();
            if (panelConfig) {
              setActivePanel(panelConfig);
              return;
            }
          }
          cmd.handler(parsed.args);
          return;
        }
        wire.pushEvent({
          type: "notification",
          title: "Unknown command",
          body: `/${parsed.name} is not a recognized command. Type /help for available commands.`,
        });
        return;
      }

      // Shell mode: run as shell command
      if (shellMode) {
        runShellCommand(input, pushNotification);
        return;
      }

      onSubmit?.(input);
    },
    [allCommands, onSubmit, wire, shellMode, pushNotification],
  );

  // Handle opening a command panel from slash menu
  const handleOpenPanel = useCallback(
    (cmd: SlashCommand) => {
      if (cmd.panel) {
        const panelConfig = cmd.panel();
        if (panelConfig) {
          setActivePanel(panelConfig);
          return;
        }
      }
      // Fallback: execute handler directly
      cmd.handler("");
    },
    [],
  );

  // Close command panel
  const handleClosePanel = useCallback(() => {
    setActivePanel(null);
  }, []);

  // Handle approval response
  const handleApprovalResponse = useCallback(
    (decision: ApprovalResponseKind, feedback?: string) => {
      if (wire.pendingApproval) {
        onApprovalResponse?.(wire.pendingApproval.id, decision, feedback);
        wire.pushEvent({
          type: "approval_response",
          requestId: wire.pendingApproval.id,
          response: decision,
        });
      }
    },
    [wire.pendingApproval, onApprovalResponse, wire],
  );


  return (
    <Box flexDirection="column" minHeight={termHeight}>
      {/* ═══ Top: Welcome box ═══ */}
      <WelcomeBox
        workDir={workDir}
        sessionId={sessionId}
        modelName={modelName}
        tip="Spot a bug or have feedback? Type /feedback right in this session — every report makes Kimi better."
      />

      {/* ═══ ChatList: height follows content ═══ */}
      <Box flexDirection="column" flexShrink={0}>
        <MessageList
          messages={wire.messages}
          isStreaming={wire.isStreaming}
        />

        {wire.isStreaming && !wire.isCompacting && (
          <StreamingSpinner stepCount={wire.stepCount} />
        )}

        <CompactionSpinner active={wire.isCompacting} />

        {wire.pendingApproval && (
          <ApprovalPrompt
            request={wire.pendingApproval}
            onRespond={handleApprovalResponse}
          />
        )}
      </Box>

      {/* ═══ InputBox: fills remaining, min 6 lines, text at top ═══ */}
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minHeight={INPUT_MIN_HEIGHT}
      >
        {activePanel ? (
          <CommandPanel config={activePanel} onClose={handleClosePanel} />
        ) : (
          <Prompt
            onSubmit={handleSubmit}
            onOpenPanel={handleOpenPanel}
            onAction={handleAction}
            disabled={false}
            isStreaming={wire.isStreaming}
            planMode={wire.status?.plan_mode ?? false}
            shellMode={shellMode}
            workDir={workDir}
            commands={allCommands}
            onSlashMenuChange={setSlashMenuVisible}
            clearSignal={clearInputSignal}
            prefillText={prefillText}
          />
        )}
      </Box>

      {/* ═══ Bottom: Status bar (always visible) ═══ */}
      <StatusBar
        modelName={modelName}
        workDir={workDir}
        status={wire.status}
        isStreaming={wire.isStreaming}
        stepCount={wire.stepCount}
        isCompacting={wire.isCompacting}
        planMode={wire.status?.plan_mode ?? false}
        shellMode={shellMode}
        thinking={thinking}
        gitBranch={gitStatus.branch}
        gitDirty={gitStatus.dirty}
        gitAhead={gitStatus.ahead}
        gitBehind={gitStatus.behind}
        toasts={wire.notifications}
        onDismissToast={wire.dismissNotification}
      />
    </Box>
  );
}
