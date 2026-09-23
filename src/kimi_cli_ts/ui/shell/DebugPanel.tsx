/**
 * DebugPanel.tsx — Context debug viewer.
 * Corresponds to Python's ui/shell/debug.py.
 *
 * Pixel-perfect style match with Python version:
 * - Full Context Info panel with cyan border
 * - Horizontal rule separator
 * - Message panels with role-color borders
 * - Nested thinking/tool-call panels
 *
 * Uses KMessage/KContentPart types from context-types.ts for full
 * type safety across both Python (kosong) and TS (Anthropic) formats.
 */

import React from "react";
import { Box, Text, useStdout } from "ink";
import { usePanelKeyboard } from "../hooks/usePanelKeyboard.ts";
import type {
	KContextInfo,
	KMessage,
	KContentPart,
	KTextPart,
	KThinkPart,
	KImageURLPart,
	KImagePart,
	KAudioURLPart,
	KVideoURLPart,
	KToolUsePart,
	KToolResultPart,
	KToolCall,
} from "./context-types.ts";

// Re-export for external use
export type { KContextInfo as ContextInfo } from "./context-types.ts";

// ── Props ────────────────────────────────────────────────

export interface DebugPanelProps {
	context: KContextInfo;
	messages: KMessage[];
	onClose?: () => void;
}

// ── Color constants ──────────────────────────────────────

const ROLE_COLORS: Record<string, string> = {
	system: "#d787d7", // magenta
	developer: "#d787d7", // magenta
	user: "#5fff5f", // green
	assistant: "#5fafff", // blue
	tool: "#ffff5f", // yellow
};

const DIM_COLOR = "#888888";
const BORDER_COLOR = "#555555";

function getRoleColor(role: string): string {
	return ROLE_COLORS[role] || "white";
}

// ── Panel box ────────────────────────────────────────────

function PanelBox({
	title,
	color = BORDER_COLOR,
	children,
}: {
	title?: string;
	color?: string;
	children: React.ReactNode;
}) {
	const { stdout } = useStdout();
	const width = stdout?.columns ?? 80;
	const contentWidth = width - 4; // 2 padding + 2 border chars

	const titleStr = title ? ` ${title} ` : "";
	const titleLen = titleStr.length;
	const leftDashes = Math.max(0, Math.floor((contentWidth - titleLen) / 2));
	const rightDashes = contentWidth - titleLen - leftDashes;

	return (
		<Box flexDirection="column">
			<Text
				color={color}
			>{`╭${"─".repeat(leftDashes)}${titleStr}${"─".repeat(rightDashes)}╮`}</Text>
			<Box paddingX={1} flexDirection="column">
				{children}
			</Box>
			<Text color={color}>{`╰${"─".repeat(contentWidth)}╯`}</Text>
		</Box>
	);
}

// ── Content part rendering ───────────────────────────────

function renderTextPart(part: KTextPart): React.ReactNode {
	const text = part.text;
	if (text.trim().startsWith("<system>") && text.trim().endsWith("</system>")) {
		const inner = text.trim().slice(8, -9).trim();
		return (
			<PanelBox title="system" color={DIM_COLOR}>
				<Text>{inner}</Text>
			</PanelBox>
		);
	}
	return <Text>{text}</Text>;
}

function renderThinkPart(part: KThinkPart): React.ReactNode {
	return (
		<PanelBox title="thinking" color="#00d7ff">
			<Text>{part.think}</Text>
		</PanelBox>
	);
}

function renderImageURLPart(part: KImageURLPart): React.ReactNode {
	const url = part.image_url.url;
	const display = url.length > 80 ? url.slice(0, 80) + "..." : url;
	return <Text color="#5fafff">[Image] {display}</Text>;
}

function renderImagePart(part: KImagePart): React.ReactNode {
	const data = part.source.data;
	const display = data.length > 80 ? data.slice(0, 80) + "..." : data;
	return <Text color="#5fafff">[Image] {display}</Text>;
}

function renderAudioURLPart(part: KAudioURLPart): React.ReactNode {
	const url = part.audio_url.url;
	const idText = part.audio_url.id ? ` (id: ${part.audio_url.id})` : "";
	const display = url.length > 80 ? url.slice(0, 80) + "..." : url;
	return (
		<Text color="#5fafff">
			[Audio{idText}] {display}
		</Text>
	);
}

function renderVideoURLPart(part: KVideoURLPart): React.ReactNode {
	const url = part.video_url.url;
	const display = url.length > 80 ? url.slice(0, 80) + "..." : url;
	return <Text color="#5fafff">[Video] {display}</Text>;
}

function renderToolUsePart(part: KToolUsePart): React.ReactNode {
	let argsStr: string;
	if (typeof part.input === "object" && part.input !== null) {
		argsStr = JSON.stringify(part.input, null, 2);
	} else {
		argsStr = "{}";
	}
	return (
		<PanelBox title="Tool Call" color="#ffff5f">
			<Text color="#5fafff" bold>
				Function: {part.name}
			</Text>
			<Text color={DIM_COLOR}>Call ID: {part.id}</Text>
			<Text bold>Arguments:</Text>
			<Text>{argsStr}</Text>
		</PanelBox>
	);
}

function renderToolResultPart(part: KToolResultPart): React.ReactNode {
	const content = part.content;
	const trimmed = content.trim();
	if (trimmed.startsWith("<system>")) {
		const systemEnd = trimmed.indexOf("</system>");
		if (systemEnd !== -1) {
			const systemText = trimmed.slice(8, systemEnd).trim();
			const remainder = trimmed.slice(systemEnd + 9).trim();
			return (
				<Box flexDirection="column">
					<PanelBox title="system" color={DIM_COLOR}>
						<Text>{systemText}</Text>
					</PanelBox>
					{remainder ? <Text>{remainder}</Text> : null}
				</Box>
			);
		}
	}
	return <Text>{content}</Text>;
}

function renderContentPart(part: KContentPart): React.ReactNode {
	switch (part.type) {
		case "text":
			return renderTextPart(part);
		case "think":
			return renderThinkPart(part);
		case "image_url":
			return renderImageURLPart(part);
		case "image":
			return renderImagePart(part);
		case "audio_url":
			return renderAudioURLPart(part);
		case "video_url":
			return renderVideoURLPart(part);
		case "tool_use":
			return renderToolUsePart(part);
		case "tool_result":
			return renderToolResultPart(part);
		default:
			return <Text color="#ff5f5f">[Unknown: {(part as any).type}]</Text>;
	}
}

// ── Tool call rendering (Python format) ──────────────────

function renderToolCall(tc: KToolCall): React.ReactNode {
	let argsStr = tc.function.arguments || "{}";
	try {
		argsStr = JSON.stringify(JSON.parse(argsStr), null, 2);
	} catch {
		/* keep raw */
	}

	return (
		<PanelBox title="Tool Call" color="#ffff5f">
			<Text color="#5fafff" bold>
				Function: {tc.function.name}
			</Text>
			<Text color={DIM_COLOR}>Call ID: {tc.id}</Text>
			<Text bold>Arguments:</Text>
			<Text>{argsStr}</Text>
		</PanelBox>
	);
}

// ── Message view ─────────────────────────────────────────

function MessageView({ msg, index }: { msg: KMessage; index: number }) {
	const roleColor = getRoleColor(msg.role);
	let titleStr = `#${index + 1} ${msg.role.toUpperCase()}`;

	if (msg.name) {
		titleStr += ` (${msg.name})`;
	}

	if (msg.tool_call_id) {
		titleStr += ` → ${msg.tool_call_id}`;
	}

	// TS tool messages: extract toolUseId from first tool_result content part
	if (msg.role === "tool" && !msg.tool_call_id && Array.isArray(msg.content)) {
		const firstResult = msg.content.find(
			(p): p is KToolResultPart => p.type === "tool_result",
		);
		if (firstResult) {
			titleStr += ` → ${firstResult.toolUseId}`;
		}
	}

	if (msg.partial) {
		titleStr += " (partial)";
	}

	const parts: React.ReactNode[] = [];

	// 1. reasoning_content (TS-specific thinking field)
	if (msg.reasoning_content) {
		parts.push(
			<Box key="reasoning" flexDirection="column">
				<PanelBox title="thinking" color="#00d7ff">
					<Text>{msg.reasoning_content}</Text>
				</PanelBox>
			</Box>,
		);
	}

	// 2. Content (string or array)
	if (typeof msg.content === "string") {
		parts.push(<Text key="content">{msg.content}</Text>);
	} else if (Array.isArray(msg.content)) {
		msg.content.forEach((part, i) => {
			parts.push(
				<Box key={`part-${i}`} flexDirection="column">
					{renderContentPart(part)}
				</Box>,
			);
		});
	}

	// 3. tool_calls (Python/kosong format: separate array)
	if (msg.tool_calls && msg.tool_calls.length > 0) {
		if (parts.length > 0) {
			parts.push(<Text key="tc-sep">{""}</Text>);
		}
		msg.tool_calls.forEach((tc, i) => {
			parts.push(
				<Box key={`tc-${i}`} flexDirection="column">
					{renderToolCall(tc)}
				</Box>,
			);
		});
	}

	// 4. Empty message fallback
	if (parts.length === 0) {
		parts.push(
			<Text key="empty" color={DIM_COLOR} italic>
				[empty message]
			</Text>,
		);
	}

	return (
		<Box flexDirection="column" marginBottom={1}>
			<PanelBox title={titleStr} color={roleColor}>
				{parts.length === 1 ? (
					parts[0]
				) : (
					<Box flexDirection="column">{parts}</Box>
				)}
			</PanelBox>
		</Box>
	);
}

// ── DebugPanel ───────────────────────────────────────────

export function DebugPanel({ context, messages, onClose }: DebugPanelProps) {
	const { stdout } = useStdout();
	const width = stdout?.columns ?? 80;

	usePanelKeyboard({
		onEscape: () => onClose?.(),
	});

	const escHint = (
		<>
			<Text color={DIM_COLOR}>{"─".repeat(width - 2)}</Text>
			<Box paddingX={1} justifyContent="flex-end">
				<Text color={DIM_COLOR}>Esc close</Text>
			</Box>
		</>
	);

	if (messages.length === 0) {
		return (
			<Box flexDirection="column">
				{escHint}
				<PanelBox title="" color="#ffff5f">
					<Text>Context is empty - no messages yet</Text>
				</PanelBox>
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			{escHint}

			{/* Context info */}
			<PanelBox title="Context Info" color="#00d7ff">
				<Text bold>Total messages: {context.totalMessages}</Text>
				<Text bold>Token count: {context.tokenCount.toLocaleString()}</Text>
				<Text bold>Checkpoints: {context.checkpoints}</Text>
				{context.trajectory && (
					<Text color={DIM_COLOR}>Trajectory: {context.trajectory}</Text>
				)}
			</PanelBox>

			{/* Separator */}
			<Text color={DIM_COLOR}>{"─".repeat(width - 2)}</Text>

			{/* Messages */}
			{messages.map((msg, idx) => (
				<MessageView key={`msg-${idx}`} msg={msg} index={idx} />
			))}
		</Box>
	);
}

export default DebugPanel;
