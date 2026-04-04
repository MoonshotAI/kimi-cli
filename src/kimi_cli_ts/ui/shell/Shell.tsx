/**
 * Shell.tsx — Main REPL component.
 *
 * Shell is a thin orchestrator:
 * - Owns useShellInput (all keyboard + UI state)
 * - Wires external callbacks (submit, interrupt, plan mode, etc.)
 * - Renders layout: Static → streaming → PromptView → bottom slot
 */

import React, { useCallback, useEffect, useState } from "react";
import { Box, Static, useApp, useStdout } from "ink";
import { MessageList, StaticMessageView } from "./Visualize.tsx";
import { PromptView } from "./PromptView.tsx";
import { WelcomeBox } from "../components/WelcomeBox.tsx";
import { StatusBar } from "../components/StatusBar.tsx";
import { ApprovalPrompt } from "../components/ApprovalPrompt.tsx";
import { ChoicePanel, ContentPanel } from "../components/CommandPanel.tsx";
import { SlashMenu } from "../components/SlashMenu.tsx";
import { MentionMenu } from "../components/MentionMenu.tsx";
import { useGitStatus } from "../hooks/useGitStatus.ts";
import { StreamingSpinner, CompactionSpinner } from "../components/Spinner.tsx";
import { useWire } from "../hooks/useWire.ts";
import { useShellInput } from "./input-state.ts";
import {
  createShellSlashCommands,
  parseSlashCommand,
  findSlashCommand,
} from "./slash.ts";
import { setActiveTheme } from "../theme.ts";
import type { WireUIEvent } from "./events.ts";
import type { ApprovalResponseKind } from "../../wire/types.ts";
import type { SlashCommand } from "../../types.ts";

import { tmpdir } from "node:os";
import { join } from "node:path";

async function runShellCommand(
  command: string,
  notify: (title: string, body: string) => void,
): Promise<void> {
  const trimmed = command.trim();
  if (!trimmed) return;
  if (trimmed.split(/\s+/)[0] === "cd") {
    notify("Shell", "Warning: Directory changes are not preserved.");
    return;
  }
  try {
    const proc = Bun.spawn(["sh", "-c", trimmed], { stdio: ["inherit", "inherit", "inherit"], env: process.env });
    await proc.exited;
  } catch (err: any) {
    notify("Shell", `Failed: ${err?.message ?? err}`);
  }
}

async function openExternalEditor(
  notify: (title: string, body: string) => void,
  onSubmit?: (input: string) => void,
): Promise<void> {
  const editor = process.env.VISUAL || process.env.EDITOR || "vim";
  const tmpFile = join(tmpdir(), `kimi-input-${Date.now()}.md`);
  try {
    await Bun.write(tmpFile, "");
    const proc = Bun.spawn(editor.split(/\s+/).concat(tmpFile), { stdio: ["inherit", "inherit", "inherit"] });
    if ((await proc.exited) !== 0) { notify("Editor", "Editor exited with error"); return; }
    const content = (await Bun.file(tmpFile).text()).trim();
    if (content && onSubmit) onSubmit(content);
    else if (!content) notify("Editor", "Empty input, nothing submitted.");
  } catch (err: any) {
    notify("Editor", `Failed: ${err?.message ?? err}`);
  } finally {
    try { require("node:fs").unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

function deduplicateCommands(commands: SlashCommand[]): SlashCommand[] {
  const seen = new Map<string, SlashCommand>();
  for (const cmd of commands) if (!seen.has(cmd.name)) seen.set(cmd.name, cmd);
  return [...seen.values()];
}

export interface ShellProps {
  modelName?: string;
  workDir?: string;
  sessionId?: string;
  sessionDir?: string;
  sessionTitle?: string;
  thinking?: boolean;
  yolo?: boolean;
  prefillText?: string;
  onSubmit?: (input: string) => void;
  onInterrupt?: () => void;
  onPlanModeToggle?: () => Promise<boolean>;
  onApprovalResponse?: (requestId: string, decision: ApprovalResponseKind, feedback?: string) => void;
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
  yolo = false,
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

  const wire = useWire({ onReady: onWireReady });
  const gitStatus = useGitStatus();

  const pushNotification = useCallback(
    (title: string, body: string) => wire.pushEvent({ type: "notification", title, body }),
    [wire],
  );

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
    triggerReload: (newSessionId: string, prefill?: string) => onReload?.(newSessionId, prefill),
  });

  const allCommands = deduplicateCommands([...shellCommands, ...extraSlashCommands]);

  useEffect(() => {
    const onResize = () => setTermHeight(stdout?.rows || 24);
    stdout?.on("resize", onResize);
    return () => { stdout?.off("resize", onResize); };
  }, [stdout]);

  // ── Input state machine (owns ALL keyboard handling) ──
  const SHELL_MODE_COMMANDS = new Set(["clear", "exit", "help", "theme", "version", "quit", "q", "cls", "reset", "h", "?"]);

  const inputState = useShellInput({
    commands: allCommands,
    workDir,
    onSubmit: useCallback(
      (input: string) => {
        const parsed = parseSlashCommand(input);
        if (parsed) {
          if (inputState.shellMode && !SHELL_MODE_COMMANDS.has(parsed.name)) {
            wire.pushEvent({ type: "notification", title: "Shell mode", body: `/${parsed.name} is not available in shell mode.` });
            return;
          }
          const cmd = findSlashCommand(allCommands, parsed.name);
          if (cmd) {
            if (cmd.panel && !parsed.args) {
              const pc = cmd.panel();
              if (pc) { inputState.openPanel(pc); return; }
            }
            const result = cmd.handler(parsed.args);
            if (result && typeof result.then === "function") {
              result.then((feedback: void | string) => {
                if (typeof feedback === "string") {
                  wire.pushEvent({ type: "slash_result", userInput: input, text: feedback });
                }
              });
            }
            return;
          }
          wire.pushEvent({ type: "notification", title: "Unknown command", body: `/${parsed.name} is not recognized. Type /help.` });
          return;
        }
        if (inputState.shellMode) { runShellCommand(input, pushNotification); return; }
        onSubmit?.(input);
      },
      [allCommands, onSubmit, wire, pushNotification],
    ),
    onSlashExecute: useCallback((cmd: SlashCommand) => {
      const result = cmd.handler("");
      if (result && typeof result.then === "function") {
        result.then((feedback: void | string) => {
          if (typeof feedback === "string") {
            wire.pushEvent({ type: "slash_result", userInput: `/${cmd.name}`, text: feedback });
          }
        });
      }
    }, [wire]),
    onExit: useCallback(() => exit(), [exit]),
    onInterrupt: useCallback(() => {
      if (wire.isStreaming) {
        onInterrupt?.();
        wire.pushEvent({ type: "error", message: "Interrupted by user" });
      }
    }, [wire, onInterrupt]),
    onPlanModeToggle: useCallback(() => {
      onPlanModeToggle?.()
        .then((s) => pushNotification("Plan mode", s ? "ON" : "OFF"))
        .catch((e: unknown) => pushNotification("Plan mode", `Error: ${String(e)}`));
    }, [onPlanModeToggle, pushNotification]),
    onOpenEditor: useCallback(() => openExternalEditor(pushNotification, onSubmit), [pushNotification, onSubmit]),
    onNotify: pushNotification,
  });

  const handleApprovalResponse = useCallback(
    (decision: ApprovalResponseKind, feedback?: string) => {
      if (wire.pendingApproval) {
        onApprovalResponse?.(wire.pendingApproval.id, decision, feedback);
        wire.pushEvent({ type: "approval_response", requestId: wire.pendingApproval.id, response: decision });
      }
    },
    [wire.pendingApproval, onApprovalResponse, wire],
  );

  // ── Prompt symbol ──
  const mode = inputState.mode;
  const promptSymbol =
    mode.type === "panel_input" ? "▸ "
    : inputState.shellMode ? "$ "
    : wire.isStreaming ? "💫 "
    : (wire.status?.plan_mode ?? false) ? "📋 "
    : "✨ ";

  // ── Static items ──
  const staticItems = React.useMemo(() => {
    const welcome = { id: "__welcome__", _isWelcome: true as const };
    const msgs = wire.isStreaming ? wire.messages.slice(0, -1) : wire.messages;
    return [welcome, ...msgs];
  }, [wire.isStreaming, wire.messages]);

  return (
    <Box flexDirection="column">
      <Static items={staticItems}>
        {(item: any) =>
          item._isWelcome ? (
            <WelcomeBox key="__welcome__" workDir={workDir} sessionId={sessionId} modelName={modelName}
              tip="Spot a bug or have feedback? Type /feedback right in this session — every report makes Kimi better." />
          ) : (
            <StaticMessageView key={item.id} message={item} />
          )
        }
      </Static>

      <Box flexDirection="column" flexShrink={0}>
        {wire.isStreaming && wire.messages.length > 0 && (
          <MessageList messages={wire.messages.slice(-1)} isStreaming={true} />
        )}
        {wire.isStreaming && !wire.isCompacting && <StreamingSpinner stepCount={wire.stepCount} />}
        <CompactionSpinner active={wire.isCompacting} />
        {wire.pendingApproval && <ApprovalPrompt request={wire.pendingApproval} onRespond={handleApprovalResponse} />}
      </Box>

      <PromptView
        value={inputState.value}
        cursorOffset={inputState.cursorOffset}
        bufferedLines={inputState.bufferedLines}
        promptSymbol={promptSymbol}
        panelTitle={mode.type === "panel_input" ? mode.config.title : undefined}
        password={mode.type === "panel_input" ? mode.config.password : undefined}
      />

      {mode.type === "panel_choice" ? (
        <ChoicePanel config={mode.config} selectedIndex={mode.index} />
      ) : mode.type === "panel_content" ? (
        <ContentPanel config={mode.config} scrollOffset={mode.scrollOffset} />
      ) : inputState.showSlashMenu ? (
        <SlashMenu commands={allCommands} filter={inputState.slashFilter} selectedIndex={inputState.slashMenuIndex} />
      ) : inputState.showMentionMenu ? (
        <MentionMenu suggestions={inputState.mentionSuggestions} selectedIndex={inputState.mentionMenuIndex} />
      ) : (
        <StatusBar
          modelName={modelName} workDir={workDir} status={wire.status}
          isStreaming={wire.isStreaming} stepCount={wire.stepCount}
          isCompacting={wire.isCompacting} planMode={wire.status?.plan_mode ?? false}
          yolo={yolo} shellMode={inputState.shellMode} thinking={thinking}
          gitBranch={gitStatus.branch} gitDirty={gitStatus.dirty}
          gitAhead={gitStatus.ahead} gitBehind={gitStatus.behind}
          toasts={wire.notifications} onDismissToast={wire.dismissNotification}
        />
      )}
    </Box>
  );
}
