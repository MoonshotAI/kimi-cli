/**
 * Shell.tsx — Main REPL component.
 *
 * Shell is a thin orchestrator:
 * - Owns useShellInput (all keyboard + UI state)
 * - Wires external callbacks (submit, interrupt, plan mode, etc.)
 * - Renders layout: Static → streaming → PromptView → bottom slot
 */

import React, { useCallback, useEffect, useRef } from "react";
import { Box, Static, useApp } from "ink";
import { MessageList, StaticMessageView } from "./Visualize.tsx";
import { PromptView } from "./PromptView.tsx";
import { WelcomeBox } from "../components/WelcomeBox.tsx";
import { StatusBar } from "../components/StatusBar.tsx";
import { ApprovalPanel } from "./ApprovalPanel.tsx";
import { QuestionPanel } from "./QuestionPanel.tsx";
import {
	resolveQuestionRequest,
	rejectQuestionRequest,
} from "../../tools/ask_user/index.ts";
import { ChoicePanel, ContentPanel } from "../components/CommandPanel.tsx";
import { DebugPanel } from "./DebugPanel.tsx";
import { TaskPanel } from "./TaskPanel.tsx";
import { SlashMenu } from "../components/SlashMenu.tsx";
import { MentionMenu } from "../components/MentionMenu.tsx";
import { UsagePanel } from "./UsagePanel.tsx";
import { useGitStatus } from "../hooks/useGitStatus.ts";
import { useUsagePanel } from "../hooks/useUsagePanel.ts";
import { StreamingSpinner, CompactionSpinner } from "../components/Spinner.tsx";
import { useWire } from "../hooks/useWire.ts";
import { useReplayHistory } from "../hooks/useReplayHistory.ts";
import { useShellInput } from "./input-state.ts";
import { createShellSlashCommands } from "./slash.ts";
import { setActiveTheme } from "../theme.ts";
import { createAllCommands } from "./shell-commands.ts";
import { useShellCallbacks } from "./useShellCallbacks.ts";
import { getPromptSymbol } from "./usePromptSymbol.ts";
import { getLastFrameHeight } from "../renderer/index.ts";
import { useShellLayout } from "./useShellLayout.ts";
import type { WireUIEvent } from "./events.ts";
import type { ApprovalResponseKind } from "../../wire/types.ts";

export interface ShellProps {
	modelName?: string;
	workDir?: string;
	sessionId?: string;
	sessionDir?: string;
	sessionTitle?: string;
	thinking?: boolean;
	yolo?: boolean;
	prefillText?: string;
	onSubmit?: (input: string) => Promise<void>;
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

import type { SlashCommand } from "../../types.ts";

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
	const wire = useWire({ onReady: onWireReady });
	const gitStatus = useGitStatus();

	// Load conversation history on session resume
	const { turns: replayTurns } = useReplayHistory({
		sessionDir,
		enabled: !!sessionDir,
	});

	// Replay historical turns into wire state so they persist as regular messages.
	// Uses a ref to ensure we only replay once per mount.
	const replayedRef = useRef(false);
	useEffect(() => {
		if (replayedRef.current || replayTurns.length === 0) return;
		replayedRef.current = true;

		for (const turn of replayTurns) {
			wire.pushEvent({ type: "turn_begin", userInput: turn.userInput });

			for (const event of turn.events) {
				switch (event.type) {
					case "text":
						wire.pushEvent({ type: "text_delta", text: event.text || "" });
						break;
					case "think":
						wire.pushEvent({ type: "think_delta", text: event.text || "" });
						break;
					case "tool_call":
						wire.pushEvent({
							type: "tool_call",
							id: event.toolCallId || "",
							name: event.toolName || "",
							arguments: event.toolArgs || "",
						});
						break;
					case "tool_result":
						wire.pushEvent({
							type: "tool_result",
							toolCallId: event.toolCallId || "",
							result: {
								tool_call_id: event.toolCallId || "",
								return_value: {
									output: event.text || "",
									isError: event.isError || false,
								},
								display: (event as any).display ?? [],
							},
						});
						break;
				}
			}

			wire.pushEvent({ type: "turn_end" });
		}
	}, [replayTurns, wire]);

	const pushNotification = useCallback(
		(title: string, body: string) =>
			wire.pushEvent({ type: "notification", title, body }),
		[wire],
	);

	// ── Commands ──
	const usagePanel = useUsagePanel();

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
		triggerReload: (newSessionId: string, prefill?: string) =>
			onReload?.(newSessionId, prefill),
		sessionId,
		showUsage: async (config) => {
			await usagePanel.show(config, config.default_model);
		},
		soulClear: async () => {
			// Find and call the soul-level /clear handler (context clear + status update)
			const soulClearCmd = extraSlashCommands.find((c) => c.name === "clear");
			if (soulClearCmd) {
				await soulClearCmd.handler("");
			}
		},
		getDynamicViewportHeight: () => getLastFrameHeight(),
		onSubmitExternal: onSubmit,
	});
	const allCommands = createAllCommands(shellCommands, extraSlashCommands);

	// ── Callbacks ──
	const { inputCallbacks, handleApprovalResponse, setInputStateAccessor } =
		useShellCallbacks({
			wire,
			allCommands,
			shellCommands,
			exit: () => exit(),
			pushNotification,
			onSubmitExternal: onSubmit,
			onInterruptExternal: onInterrupt,
			onPlanModeToggleExternal: onPlanModeToggle,
			onApprovalResponseExternal: onApprovalResponse,
			onReloadExternal: onReload,
		});

	// ── Input state ──
	const inputState = useShellInput({
		commands: allCommands,
		workDir,
		...inputCallbacks,
	});

	// Keep ref in sync so callbacks can access shellMode/openPanel.
	useEffect(() => {
		setInputStateAccessor({
			shellMode: inputState.shellMode,
			openPanel: inputState.openPanel,
		});
	});

	// ── Layout ──
	const { staticItems, resizeKey } = useShellLayout(
		wire.messages,
		wire.isStreaming,
	);
	const mode = inputState.mode;
	const promptSymbol = getPromptSymbol(
		mode,
		inputState.shellMode,
		thinking,
		wire.status?.plan_mode ?? false,
	);

	return (
		<Box key={resizeKey} flexDirection="column">
			<Static items={staticItems}>
				{(item: any) =>
					item._isWelcome ? (
						<WelcomeBox
							key="__welcome__"
							workDir={workDir}
							sessionId={sessionId}
							modelName={modelName}
							tip="Spot a bug or have feedback? Type /feedback right in this session — every report makes Kimi better."
						/>
					) : (
						<StaticMessageView key={item.id} message={item} />
					)
				}
			</Static>

			<Box flexDirection="column" flexShrink={0}>
				{wire.isStreaming && wire.messages.length > 0 && (
					<MessageList messages={wire.messages.slice(-1)} isStreaming={true} />
				)}
				{wire.isStreaming && !wire.isCompacting && (
					<StreamingSpinner stepCount={wire.stepCount} />
				)}
				<CompactionSpinner active={wire.isCompacting} />
				{wire.pendingApproval && (
					<ApprovalPanel
						key={wire.pendingApproval.id}
						request={wire.pendingApproval}
						onRespond={handleApprovalResponse}
					/>
				)}
				{wire.pendingQuestion && (
					<QuestionPanel
						key={wire.pendingQuestion.id}
						request={wire.pendingQuestion}
						onAnswer={(answers) => {
							resolveQuestionRequest(wire.pendingQuestion!.id, answers);
							wire.pushEvent({
								type: "question_response",
								requestId: wire.pendingQuestion!.id,
								answers,
							});
						}}
						onCancel={() => {
							rejectQuestionRequest(wire.pendingQuestion!.id);
							wire.pushEvent({
								type: "question_response",
								requestId: wire.pendingQuestion!.id,
								answers: {},
							});
						}}
					/>
				)}
			</Box>

			<PromptView
				value={inputState.value}
				cursorOffset={inputState.cursorOffset}
				bufferedLines={inputState.bufferedLines}
				promptSymbol={promptSymbol}
				panelTitle={mode.type === "panel_input" ? mode.config.title : undefined}
				password={
					mode.type === "panel_input" ? mode.config.password : undefined
				}
			/>

			{usagePanel.visible ? (
				<UsagePanel
					summary={usagePanel.summary}
					limits={usagePanel.limits}
					loading={usagePanel.loading}
					error={usagePanel.error}
					onClose={usagePanel.hide}
				/>
			) : mode.type === "panel_choice" ? (
				<ChoicePanel
					config={mode.config}
					onClose={inputState.closePanel}
					onChain={inputState.openPanel}
					onReload={onReload}
				/>
			) : mode.type === "panel_content" ? (
				<ContentPanel config={mode.config} onClose={inputState.closePanel} />
			) : mode.type === "panel_debug" ? (
				<DebugPanel
					context={mode.config.data.context}
					messages={mode.config.data.messages}
					onClose={inputState.closePanel}
				/>
			) : mode.type === "panel_task" ? (
				<TaskPanel onClose={inputState.closePanel} />
			) : inputState.showSlashMenu ? (
				<SlashMenu
					commands={allCommands}
					filter={inputState.slashFilter}
					selectedIndex={inputState.slashMenuIndex}
				/>
			) : inputState.showMentionMenu ? (
				<MentionMenu
					suggestions={inputState.mentionSuggestions}
					selectedIndex={inputState.mentionMenuIndex}
				/>
			) : (
				<StatusBar
					modelName={modelName}
					workDir={workDir}
					status={wire.status}
					isStreaming={wire.isStreaming}
					stepCount={wire.stepCount}
					isCompacting={wire.isCompacting}
					planMode={wire.status?.plan_mode ?? false}
					yolo={wire.status?.yolo ?? yolo}
					shellMode={inputState.shellMode}
					thinking={thinking}
					gitBranch={gitStatus.branch}
					gitDirty={gitStatus.dirty}
					gitAhead={gitStatus.ahead}
					gitBehind={gitStatus.behind}
					toasts={wire.notifications}
					onDismissToast={wire.dismissNotification}
				/>
			)}
		</Box>
	);
}
