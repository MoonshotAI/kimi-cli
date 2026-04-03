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

import React, { useCallback, useEffect, useState } from "react";
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
import { useKeyboard } from "./keyboard.ts";
import {
  createShellSlashCommands,
  parseSlashCommand,
  findSlashCommand,
} from "./slash.ts";
import { setActiveTheme } from "../theme.ts";
import type { WireUIEvent } from "./events.ts";
import type { ApprovalResponseKind } from "../../wire/types.ts";
import type { SlashCommand, CommandPanelConfig } from "../../types.ts";

const INPUT_MIN_HEIGHT = 6;

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

  // Global keyboard handling: Ctrl+C / Esc / Shift+Tab
  useKeyboard({
    onAction: (action) => {
      switch (action) {
        case "interrupt":
          if (activePanel) {
            // Close command panel on interrupt
            setActivePanel(null);
          } else if (wire.isStreaming) {
            // Interrupt the running turn: abort the soul + push UI event
            onInterrupt?.();
            wire.pushEvent({ type: "error", message: "Interrupted by user" });
          }
          break;
        case "clear-input":
          // Double-Esc: clear the input box
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
        // "exit" is handled internally by useKeyboard (calls exit())
      }
    },
    active: true,
  });

  // Handle user input
  const handleSubmit = useCallback(
    (input: string) => {
      const parsed = parseSlashCommand(input);
      if (parsed) {
        const cmd = findSlashCommand(allCommands, parsed.name);
        if (cmd) {
          // If command has panel and no args provided, try opening panel
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
      onSubmit?.(input);
    },
    [allCommands, onSubmit, wire],
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
            disabled={false}
            isStreaming={wire.isStreaming}
            planMode={wire.status?.plan_mode ?? false}
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
