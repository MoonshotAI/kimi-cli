/**
 * Visualize.tsx — Message visualization components.
 * Corresponds to Python's ui/shell/visualize.py.
 *
 * Components:
 * - MessageList: renders all messages with step headers
 * - MessageView: single message with role-based styling
 * - ToolCallView: tool call display (collapsible) with key argument extraction
 * - StreamingText: streaming text with cursor + full markdown rendering
 * - ThinkingView: thinking/reasoning display
 * - CodeBlockView: syntax-highlighted code blocks
 * - TableView: markdown table rendering
 * - ErrorRecoveryView: API error classification display
 */

import React, { useState, useMemo } from "react";
import { Box, Text, Newline } from "ink";
import chalk from "chalk";
import { getStyles, getMessageColors, getDiffColors } from "../theme.ts";
import type {
	UIMessage,
	MessageSegment,
	TextSegment,
	ThinkSegment,
	ToolCallSegment,
} from "./events.ts";
import type { ToolResult, DisplayBlock } from "../../wire/types.ts";
import { extractKeyArgument } from "../../tools/types.ts";

// ── MessageList ────────────────────────────────────────────

interface MessageListProps {
	messages: UIMessage[];
	isStreaming: boolean;
	stepCount?: number;
}

export function MessageList({
	messages,
	isStreaming,
	stepCount,
}: MessageListProps) {
	return (
		<Box flexDirection="column">
			{messages.map((msg, idx) => (
				<MessageView
					key={msg.id}
					message={msg}
					isLast={idx === messages.length - 1}
					isStreaming={isStreaming && idx === messages.length - 1}
					stepCount={idx === messages.length - 1 ? stepCount : undefined}
				/>
			))}
		</Box>
	);
}

/**
 * StaticMessageView — rendered inside <Static>, written once and never re-drawn.
 * This makes completed messages selectable/copyable with the mouse.
 */
export function StaticMessageView({ message }: { message: UIMessage }) {
	return <MessageView message={message} isLast={false} isStreaming={false} />;
}

// ── MessageView ────────────────────────────────────────────

interface MessageViewProps {
	message: UIMessage;
	isLast: boolean;
	isStreaming: boolean;
	stepCount?: number;
}

function MessageView({
	message,
	isLast,
	isStreaming,
	stepCount,
}: MessageViewProps) {
	const colors = getMessageColors();

	const roleLabel = getRoleLabel(message.role);
	const roleColor = getRoleColor(message.role, colors);

	// For user messages, render inline with emoji prefix
	if (message.role === "user") {
		const userText = message.segments
			.filter((s): s is TextSegment => s.type === "text")
			.map((s) => s.text)
			.join("");
		return (
			<Box flexDirection="column" marginBottom={1}>
				<Box>
					<Text color={roleColor}>{roleLabel} </Text>
					<Text>{userText}</Text>
				</Box>
			</Box>
		);
	}

	// For system messages (slash command feedback), render with bullet prefix to match Python
	if (message.role === "system") {
		const sysText = message.segments
			.filter((s): s is TextSegment => s.type === "text")
			.map((s) => s.text)
			.join("");
		return (
			<Box flexDirection="column" marginBottom={1}>
				<Text>• {sysText}</Text>
			</Box>
		);
	}

	// For assistant messages, no role label
	return (
		<Box flexDirection="column" marginBottom={1}>
			{/* Step count header for assistant messages */}
			{message.role === "assistant" && stepCount != null && stepCount > 0 && (
				<Text color={colors.dim}>─── Step {stepCount} ───</Text>
			)}
			{message.segments.map((segment, idx) => (
				<SegmentView
					key={idx}
					segment={segment}
					isStreaming={isStreaming && idx === message.segments.length - 1}
				/>
			))}
		</Box>
	);
}

function getRoleLabel(role: string): string {
	switch (role) {
		case "user":
			return "✨";
		case "assistant":
			return "";
		case "system":
			return "";
		case "tool":
			return "";
		default:
			return role;
	}
}

function getRoleColor(
	role: string,
	colors: ReturnType<typeof getMessageColors>,
): string {
	switch (role) {
		case "user":
			return colors.user;
		case "assistant":
			return colors.assistant;
		case "system":
			return colors.system;
		case "tool":
			return colors.tool;
		default:
			return colors.dim;
	}
}

// ── SegmentView ────────────────────────────────────────────

interface SegmentViewProps {
	segment: MessageSegment;
	isStreaming: boolean;
}

function SegmentView({ segment, isStreaming }: SegmentViewProps) {
	switch (segment.type) {
		case "text":
			return <StreamingText text={segment.text} isStreaming={isStreaming} />;
		case "think":
			return <ThinkingView text={segment.text} />;
		case "tool_call":
			return <ToolCallView toolCall={segment} />;
		default:
			return null;
	}
}

// ── StreamingText ──────────────────────────────────────────

interface StreamingTextProps {
	text: string;
	isStreaming: boolean;
}

export function StreamingText({ text, isStreaming }: StreamingTextProps) {
	const rendered = useMemo(() => renderMarkdown(text), [text]);

	return (
		<Box flexDirection="column">
			<Box>
				<Text>• </Text>
				<Box flexDirection="column" flexGrow={1}>
					{rendered}
					{isStreaming && <Text>▌</Text>}
				</Box>
			</Box>
		</Box>
	);
}

// ── ThinkingView ───────────────────────────────────────────

interface ThinkingViewProps {
	text: string;
}

export function ThinkingView({ text }: ThinkingViewProps) {
	const colors = getMessageColors();
	// Render thinking text with bullet, matching Python's BulletColumns format
	return (
		<Box>
			<Text color={colors.thinking} italic>
				• {text}
			</Text>
		</Box>
	);
}

// ── ToolCallView ───────────────────────────────────────────

interface ToolCallViewProps {
	toolCall: ToolCallSegment;
}

export function ToolCallView({ toolCall }: ToolCallViewProps) {
	// Derive collapsed from prop — when result has display blocks, stay expanded
	const collapsed = toolCall.collapsed;
	const colors = getMessageColors();

	// Format arguments for display — extract key argument
	let argsPreview = "";
	try {
		// extractKeyArgument takes (jsonString, toolName) and returns string | null
		const key = extractKeyArgument(toolCall.arguments, toolCall.name);
		argsPreview = key || truncate(toolCall.arguments, 60);
	} catch {
		// Streaming JSON: show partial arguments
		argsPreview = renderStreamingJson(toolCall.arguments);
	}

	// Python formatting: "Using ToolName (arg)" or "Used ToolName (arg)"
	const isFinished = toolCall.result !== undefined;
	const stateLabel = isFinished ? "Used " : "Using ";
	const isError = isFinished && toolCall.result?.return_value.isError;

	// Bullet: ⟳ while pending, • when finished (matches Python)
	// Color: green for success, dark_red for error/rejected, dim for pending
	const bulletColor = isFinished
		? isError
			? colors.darkRed
			: colors.highlight
		: colors.dim;
	const bullet = isFinished ? "•" : "⟳";

	// Subagent data
	const hasSubagent = !!(toolCall.subagentId && toolCall.subagentType);
	const finishedSubs = toolCall.finishedSubCalls ?? [];
	const nExtra = toolCall.nExtraSubCalls ?? 0;

	return (
		<Box flexDirection="column" marginY={0}>
			{/* Tool call headline: Using/Used ToolName (argument) */}
			<Box>
				<Text color={bulletColor}>{bullet} </Text>
				<Text>{stateLabel}</Text>
				<Text color={colors.tool}>{toolCall.name}</Text>
				{argsPreview && (
					<>
						<Text color={colors.dim}> (</Text>
						<Text color={colors.dim}>{argsPreview}</Text>
						<Text color={colors.dim}>)</Text>
					</>
				)}
			</Box>
			{/* Subagent metadata header — matches Python: "subagent {type} ({id})" in grey50 */}
			{hasSubagent && (
				<Box marginLeft={2}>
					<Text color={colors.dim}>
						subagent {toolCall.subagentType} ({toolCall.subagentId})
					</Text>
				</Box>
			)}
			{/* Hidden call count — matches Python: "N more tool calls ..." */}
			{nExtra > 0 && (
				<Box marginLeft={2}>
					<Text color={colors.dim} italic>
						{nExtra} more tool call{nExtra > 1 ? "s" : ""} ...
					</Text>
				</Box>
			)}
			{/* Finished subagent tool calls — matches Python BulletColumns pattern */}
			{finishedSubs.length > 0 && (
				<Box flexDirection="column" marginLeft={2}>
					{finishedSubs.map((sub) => {
						const subBullet = "•";
						const subColor = sub.isError ? colors.darkRed : colors.highlight;
						return (
							<Box key={sub.callId}>
								<Text color={subColor}>{subBullet} </Text>
								<Text>Used </Text>
								<Text color={colors.tool}>{sub.toolName}</Text>
								{sub.arguments ? (
									<>
										<Text color={colors.dim}> (</Text>
										<Text color={colors.dim}>{sub.arguments}</Text>
										<Text color={colors.dim}>)</Text>
									</>
								) : null}
							</Box>
						);
					})}
				</Box>
			)}
			{/* Rejected feedback line — matches Python's "  Rejected: {feedback}" in dark_red */}
			{isFinished &&
				isError &&
				toolCall.result?.return_value.output &&
				(() => {
					const output = toolCall.result!.return_value.output;
					// Check for rejection feedback pattern from approval.ts
					const rejectMatch = output.match(
						/rejected by the user\.\s*User feedback:\s*(.+)/i,
					);
					const briefBlock = toolCall.result!.display.find(
						(b) => b.type === "brief" && (b as Record<string, unknown>).brief,
					);
					const briefText = briefBlock
						? ((briefBlock as Record<string, unknown>).brief as string)
						: null;
					// Show "Rejected: feedback" if we have a brief that starts with "Rejected:"
					if (briefText?.startsWith("Rejected:")) {
						return (
							<Box marginLeft={2}>
								<Text color={colors.darkRed}>{briefText}</Text>
							</Box>
						);
					}
					// Or extract from output message
					if (rejectMatch?.[1]) {
						return (
							<Box marginLeft={2}>
								<Text color={colors.darkRed}>Rejected: {rejectMatch[1]}</Text>
							</Box>
						);
					}
					return null;
				})()}
			{!collapsed && toolCall.result && (
				<Box marginLeft={2} flexDirection="column">
					<ToolResultView result={toolCall.result} />
				</Box>
			)}
		</Box>
	);
}

// ── ToolResultView ─────────────────────────────────────────

interface ToolResultViewProps {
	result: ToolResult;
}

function ToolResultView({ result }: ToolResultViewProps) {
	const colors = getMessageColors();
	const output = result.return_value.output;
	const isError = result.return_value.isError;
	const truncated = truncate(output, 500);

	return (
		<Box flexDirection="column">
			{result.display.map((block, idx) => (
				<DisplayBlockView key={idx} block={block} isError={isError} />
			))}
			{!result.display.length && (
				<Text color={isError ? colors.error : colors.dim}>{truncated}</Text>
			)}
		</Box>
	);
}

// ── DisplayBlockView ───────────────────────────────────────

interface DisplayBlockViewProps {
	block: DisplayBlock;
	isError?: boolean;
}

function DisplayBlockView({ block, isError }: DisplayBlockViewProps) {
	const colors = getMessageColors();
	const diffColors = getDiffColors();
	const b = block as Record<string, unknown>;

	switch (block.type) {
		case "brief":
			return (
				<Text color={isError ? colors.darkRed : colors.dim}>
					{b.brief as string}
				</Text>
			);
		case "diff":
			return (
				<EnhancedDiffView
					block={{
						path: b.path as string,
						old_text: b.old_text as string,
						new_text: b.new_text as string,
						old_start: b.old_start as number | undefined,
						new_start: b.new_start as number | undefined,
					}}
				/>
			);
		case "shell":
			return (
				<Box>
					<Text color={colors.dim}>$ </Text>
					<Text color="#e6e6e6">{b.command as string}</Text>
				</Box>
			);
		case "todo": {
			const items = b.items as Array<{
				title: string;
				status: string;
			}>;
			return (
				<Box flexDirection="column">
					{items.map((item, idx) => (
						<Box key={idx}>
							<Text
								color={
									item.status === "done"
										? "#56d364"
										: item.status === "in_progress"
											? "#56a4ff"
											: colors.dim
								}
							>
								{item.status === "done"
									? "✓"
									: item.status === "in_progress"
										? "⟳"
										: "○"}{" "}
								{item.title}
							</Text>
						</Box>
					))}
				</Box>
			);
		}
		case "background_task": {
			return (
				<Box>
					<Text color="#56a4ff">⟳ </Text>
					<Text color={colors.dim}>[{b.kind as string}] </Text>
					<Text>{b.description as string}</Text>
					<Text color={colors.dim}> ({b.status as string})</Text>
				</Box>
			);
		}
		default:
			return null;
	}
}

// ── DiffView ───────────────────────────────────────────────

function DiffView({
	block,
}: {
	block: { path: string; old_text: string; new_text: string };
}) {
	const diffColors = getDiffColors();
	return (
		<Box flexDirection="column">
			<Text color="#e6e6e6" bold>
				{block.path}
			</Text>
			{block.old_text
				.split("\n")
				.filter(Boolean)
				.map((line, idx) => (
					<Text
						key={`old-${idx}`}
						color="#ff7b72"
						backgroundColor={diffColors.delBg}
					>
						- {line}
					</Text>
				))}
			{block.new_text
				.split("\n")
				.filter(Boolean)
				.map((line, idx) => (
					<Text
						key={`new-${idx}`}
						color="#56d364"
						backgroundColor={diffColors.addBg}
					>
						+ {line}
					</Text>
				))}
		</Box>
	);
}

// ── ErrorRecoveryView ──────────────────────────────────────

export interface ErrorInfo {
	type: "rate_limit" | "server_error" | "network" | "auth" | "unknown";
	message: string;
	retryable: boolean;
	retryAfter?: number;
}

export function ErrorRecoveryView({ error }: { error: ErrorInfo }) {
	const icon = error.retryable ? "⟳" : "✗";
	const color = error.retryable ? "#f2cc60" : "#ff7b72";
	const typeLabel = {
		rate_limit: "Rate Limited",
		server_error: "Server Error",
		network: "Network Error",
		auth: "Authentication Error",
		unknown: "Error",
	}[error.type];

	return (
		<Box flexDirection="column" marginY={1}>
			<Box>
				<Text color={color} bold>
					{icon} {typeLabel}
				</Text>
			</Box>
			<Box marginLeft={2}>
				<Text color={color}>{error.message}</Text>
			</Box>
			{error.retryable && error.retryAfter && (
				<Box marginLeft={2}>
					<Text color="#6b7280" italic>
						Retrying in {error.retryAfter}s…
					</Text>
				</Box>
			)}
		</Box>
	);
}

/**
 * Classify API error for display.
 */
export function classifyApiError(err: unknown): ErrorInfo {
	const msg = err instanceof Error ? err.message : String(err);
	const lower = msg.toLowerCase();

	if (lower.includes("429") || lower.includes("rate limit")) {
		const retryMatch = lower.match(/retry.after.*?(\d+)/);
		return {
			type: "rate_limit",
			message: msg,
			retryable: true,
			retryAfter: retryMatch ? parseInt(retryMatch[1]!, 10) : 60,
		};
	}
	if (
		lower.includes("500") ||
		lower.includes("502") ||
		lower.includes("503") ||
		lower.includes("504")
	) {
		return {
			type: "server_error",
			message: msg,
			retryable: true,
			retryAfter: 5,
		};
	}
	if (
		lower.includes("timeout") ||
		lower.includes("econnrefused") ||
		lower.includes("network")
	) {
		return { type: "network", message: msg, retryable: true, retryAfter: 3 };
	}
	if (
		lower.includes("401") ||
		lower.includes("403") ||
		lower.includes("auth")
	) {
		return { type: "auth", message: msg, retryable: false };
	}
	return { type: "unknown", message: msg, retryable: false };
}

// ── Markdown Rendering ─────────────────────────────────────

/**
 * Full markdown rendering to React Ink components.
 * Supports: headings, code blocks (with language hint), tables, lists,
 * blockquotes, horizontal rules, and inline formatting.
 */
function renderMarkdown(text: string): React.ReactNode {
	const lines = text.split("\n");
	const elements: React.ReactNode[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i]!;

		// Fenced code block
		const codeMatch = line.match(/^```(\w*)/);
		if (codeMatch) {
			const lang = codeMatch[1] || "";
			const codeLines: string[] = [];
			i++;
			while (i < lines.length && !lines[i]!.startsWith("```")) {
				codeLines.push(lines[i]!);
				i++;
			}
			if (i < lines.length) i++; // skip closing ```
			elements.push(
				<CodeBlockView
					key={`code-${elements.length}`}
					code={codeLines.join("\n")}
					language={lang}
				/>,
			);
			continue;
		}

		// Table detection (| header | header |)
		if (line.includes("|") && line.trim().startsWith("|")) {
			const tableLines: string[] = [line];
			i++;
			while (
				i < lines.length &&
				lines[i]!.includes("|") &&
				lines[i]!.trim().startsWith("|")
			) {
				tableLines.push(lines[i]!);
				i++;
			}
			if (tableLines.length >= 2) {
				elements.push(
					<TableView key={`table-${elements.length}`} lines={tableLines} />,
				);
				continue;
			}
			// Not a real table, render as text
			for (const tl of tableLines) {
				elements.push(
					<Text key={`text-${elements.length}`}>
						{renderInlineFormatting(tl)}
					</Text>,
				);
			}
			continue;
		}

		// Heading
		const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
		if (headingMatch) {
			const level = headingMatch[1]!.length;
			const headingText = headingMatch[2]!;
			const color = level <= 2 ? "#56a4ff" : level <= 4 ? "#e6e6e6" : "#9ca3af";
			elements.push(
				<Text key={`h-${elements.length}`} color={color} bold>
					{level <= 2 ? "█ " : level <= 4 ? "▌ " : "▎ "}
					{renderInlineFormatting(headingText)}
				</Text>,
			);
			i++;
			continue;
		}

		// Blockquote
		if (line.startsWith("> ") || line === ">") {
			const quoteLines: string[] = [];
			while (
				i < lines.length &&
				(lines[i]!.startsWith("> ") || lines[i] === ">")
			) {
				quoteLines.push(lines[i]!.replace(/^>\s?/, ""));
				i++;
			}
			elements.push(
				<Box
					key={`quote-${elements.length}`}
					borderStyle="single"
					borderLeft
					borderTop={false}
					borderRight={false}
					borderBottom={false}
					borderColor="#6b7280"
					paddingLeft={1}
				>
					<Text color="#9ca3af" italic>
						{quoteLines.join("\n")}
					</Text>
				</Box>,
			);
			continue;
		}

		// Horizontal rule
		if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
			elements.push(
				<Text key={`hr-${elements.length}`} color="#555555">
					{"─".repeat(60)}
				</Text>,
			);
			i++;
			continue;
		}

		// Unordered list
		if (/^\s*[-*+]\s+/.test(line)) {
			const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
			const bullet = indent >= 4 ? "  ◦ " : indent >= 2 ? " ◦ " : "• ";
			const content = line.replace(/^\s*[-*+]\s+/, "");
			elements.push(
				<Text key={`ul-${elements.length}`}>
					{"  ".repeat(Math.floor(indent / 2))}
					{bullet}
					{renderInlineFormatting(content)}
				</Text>,
			);
			i++;
			continue;
		}

		// Ordered list
		const olMatch = line.match(/^\s*(\d+)[.)]\s+(.*)/);
		if (olMatch) {
			const num = olMatch[1]!;
			const content = olMatch[2]!;
			elements.push(
				<Text key={`ol-${elements.length}`}>
					{"  "}
					{chalk.bold(num + ".")} {renderInlineFormatting(content)}
				</Text>,
			);
			i++;
			continue;
		}

		// Regular text
		if (line.trim() === "") {
			elements.push(<Text key={`empty-${elements.length}`}> </Text>);
		} else {
			elements.push(
				<Text key={`text-${elements.length}`}>
					{renderInlineFormatting(line)}
				</Text>,
			);
		}
		i++;
	}

	return <>{elements}</>;
}

// ── Code Block View ────────────────────────────────────────

function CodeBlockView({ code, language }: { code: string; language: string }) {
	const colors = getMessageColors();

	// Simple keyword-based syntax coloring
	const highlighted = language ? highlightCode(code, language) : code;

	return (
		<Box
			flexDirection="column"
			borderStyle="single"
			borderColor="#555555"
			paddingX={1}
			marginY={0}
		>
			{language && (
				<Text color="#6b7280" italic>
					{language}
				</Text>
			)}
			<Text>{highlighted}</Text>
		</Box>
	);
}

/**
 * Simple syntax highlighting using chalk.
 * Covers common patterns: keywords, strings, comments, numbers.
 */
function highlightCode(code: string, language: string): string {
	const lang = language.toLowerCase();

	// Language-specific keywords
	const KEYWORDS: Record<string, string[]> = {
		js: [
			"const",
			"let",
			"var",
			"function",
			"return",
			"if",
			"else",
			"for",
			"while",
			"class",
			"import",
			"export",
			"from",
			"async",
			"await",
			"new",
			"this",
			"try",
			"catch",
			"throw",
			"typeof",
			"instanceof",
			"switch",
			"case",
			"default",
			"break",
			"continue",
		],
		ts: [
			"const",
			"let",
			"var",
			"function",
			"return",
			"if",
			"else",
			"for",
			"while",
			"class",
			"import",
			"export",
			"from",
			"async",
			"await",
			"new",
			"this",
			"try",
			"catch",
			"throw",
			"typeof",
			"instanceof",
			"interface",
			"type",
			"enum",
			"implements",
			"extends",
			"switch",
			"case",
			"default",
			"break",
			"continue",
		],
		typescript: [
			"const",
			"let",
			"var",
			"function",
			"return",
			"if",
			"else",
			"for",
			"while",
			"class",
			"import",
			"export",
			"from",
			"async",
			"await",
			"new",
			"this",
			"try",
			"catch",
			"throw",
			"typeof",
			"instanceof",
			"interface",
			"type",
			"enum",
			"implements",
			"extends",
			"switch",
			"case",
			"default",
			"break",
			"continue",
		],
		javascript: [
			"const",
			"let",
			"var",
			"function",
			"return",
			"if",
			"else",
			"for",
			"while",
			"class",
			"import",
			"export",
			"from",
			"async",
			"await",
			"new",
			"this",
			"try",
			"catch",
			"throw",
			"typeof",
			"instanceof",
			"switch",
			"case",
			"default",
			"break",
			"continue",
		],
		python: [
			"def",
			"class",
			"return",
			"if",
			"elif",
			"else",
			"for",
			"while",
			"import",
			"from",
			"as",
			"try",
			"except",
			"raise",
			"with",
			"yield",
			"lambda",
			"pass",
			"break",
			"continue",
			"and",
			"or",
			"not",
			"in",
			"is",
			"None",
			"True",
			"False",
			"self",
			"async",
			"await",
		],
		py: [
			"def",
			"class",
			"return",
			"if",
			"elif",
			"else",
			"for",
			"while",
			"import",
			"from",
			"as",
			"try",
			"except",
			"raise",
			"with",
			"yield",
			"lambda",
			"pass",
			"break",
			"continue",
			"and",
			"or",
			"not",
			"in",
			"is",
			"None",
			"True",
			"False",
			"self",
			"async",
			"await",
		],
		rust: [
			"fn",
			"let",
			"mut",
			"const",
			"if",
			"else",
			"for",
			"while",
			"loop",
			"match",
			"struct",
			"enum",
			"impl",
			"trait",
			"pub",
			"use",
			"mod",
			"crate",
			"self",
			"super",
			"return",
			"async",
			"await",
			"move",
			"type",
			"where",
		],
		go: [
			"func",
			"var",
			"const",
			"if",
			"else",
			"for",
			"range",
			"switch",
			"case",
			"default",
			"return",
			"type",
			"struct",
			"interface",
			"package",
			"import",
			"go",
			"chan",
			"select",
			"defer",
			"map",
			"make",
			"new",
			"nil",
			"true",
			"false",
		],
		bash: [
			"if",
			"then",
			"else",
			"elif",
			"fi",
			"for",
			"while",
			"do",
			"done",
			"case",
			"esac",
			"function",
			"return",
			"local",
			"export",
			"echo",
			"exit",
		],
		sh: [
			"if",
			"then",
			"else",
			"elif",
			"fi",
			"for",
			"while",
			"do",
			"done",
			"case",
			"esac",
			"function",
			"return",
			"local",
			"export",
			"echo",
			"exit",
		],
	};

	const keywords = KEYWORDS[lang] || [];
	if (keywords.length === 0) return code;

	// Apply highlighting line-by-line
	return code
		.split("\n")
		.map((line) => {
			// Comments
			if (
				line.trimStart().startsWith("//") ||
				line.trimStart().startsWith("#")
			) {
				return chalk.hex("#6b7280")(line);
			}

			// String literals (basic)
			let result = line;
			result = result.replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, (m) =>
				chalk.hex("#a5d6a7")(m),
			);

			// Numbers
			result = result.replace(/\b(\d+\.?\d*)\b/g, (m) =>
				chalk.hex("#f2cc60")(m),
			);

			// Keywords
			const kwPattern = new RegExp(`\\b(${keywords.join("|")})\\b`, "g");
			result = result.replace(kwPattern, (m) => chalk.hex("#c792ea")(m));

			return result;
		})
		.join("\n");
}

// ── Table View ─────────────────────────────────────────────

function TableView({ lines }: { lines: string[] }) {
	const colors = getMessageColors();

	// Parse table
	const rows = lines
		.filter((line) => !line.match(/^\|[\s-:|]+\|$/)) // Skip separator rows
		.map((line) =>
			line
				.split("|")
				.slice(1, -1)
				.map((cell) => cell.trim()),
		);

	if (rows.length === 0) return null;

	const header = rows[0]!;
	const body = rows.slice(1);

	// Calculate column widths
	const colWidths = header.map((h, colIdx) => {
		const maxContent = Math.max(
			h.length,
			...body.map((row) => (row[colIdx] || "").length),
		);
		return Math.min(maxContent + 2, 40);
	});

	const separator = "┼" + colWidths.map((w) => "─".repeat(w)).join("┼") + "┼";

	return (
		<Box flexDirection="column" marginY={0}>
			{/* Header */}
			<Text color="#555555">
				{"┌" + colWidths.map((w) => "─".repeat(w)).join("┬") + "┐"}
			</Text>
			<Text>
				{"│"}
				{header
					.map((cell, idx) => chalk.bold(cell.padEnd(colWidths[idx]!)))
					.join("│")}
				{"│"}
			</Text>
			<Text color="#555555">
				{"├" + colWidths.map((w) => "─".repeat(w)).join("┼") + "┤"}
			</Text>
			{/* Body */}
			{body.map((row, rowIdx) => (
				<Text key={rowIdx}>
					{"│"}
					{row
						.map((cell, colIdx) => (cell || "").padEnd(colWidths[colIdx]!))
						.join("│")}
					{"│"}
				</Text>
			))}
			<Text color="#555555">
				{"└" + colWidths.map((w) => "─".repeat(w)).join("┴") + "┘"}
			</Text>
		</Box>
	);
}

// ── Inline Formatting ──────────────────────────────────────

/**
 * Render inline markdown formatting: bold, italic, code, strikethrough, links.
 */
function renderInlineFormatting(text: string): string {
	return (
		text
			// Bold + italic
			.replace(/\*\*\*(.+?)\*\*\*/g, (_, p1) => chalk.bold.italic(p1))
			// Bold
			.replace(/\*\*(.+?)\*\*/g, (_, p1) => chalk.bold(p1))
			// Italic
			.replace(/\*(.+?)\*/g, (_, p1) => chalk.italic(p1))
			.replace(/_(.+?)_/g, (_, p1) => chalk.italic(p1))
			// Strikethrough
			.replace(/~~(.+?)~~/g, (_, p1) => chalk.strikethrough(p1))
			// Inline code
			.replace(/`(.+?)`/g, (_, p1) => chalk.bold.cyanBright(p1))
			// Links [text](url)
			.replace(
				/\[(.+?)\]\((.+?)\)/g,
				(_, text, url) =>
					chalk.underline.hex("#56a4ff")(text) +
					chalk.hex("#6b7280")(` (${url})`),
			)
	);
}

// ── Streaming JSON Rendering ───────────────────────────────

/**
 * Render partial/streaming JSON arguments for tool calls.
 * Shows key-value pairs as they arrive.
 */
function renderStreamingJson(partial: string): string {
	// Try to extract readable key-value pairs from partial JSON
	const pairs: string[] = [];
	const kvPattern = /"(\w+)":\s*"([^"]*)"?/g;
	let match;
	while ((match = kvPattern.exec(partial)) !== null) {
		const key = match[1]!;
		const value = match[2]!;
		if (key.length < 20 && value.length < 80) {
			pairs.push(`${key}=${truncate(value, 40)}`);
		}
	}
	if (pairs.length > 0) {
		return pairs.slice(0, 3).join(", ");
	}
	return truncate(partial, 60);
}

// ── NotificationView ────────────────────────────────────────

export interface NotificationViewProps {
	title: string;
	body: string;
	severity?: string;
}

export function NotificationView({
	title,
	body,
	severity,
}: NotificationViewProps) {
	const icon = severity === "error" ? "✗" : severity === "warning" ? "⚠" : "ℹ";
	const color =
		severity === "error"
			? "#ff7b72"
			: severity === "warning"
				? "#f2cc60"
				: "#56a4ff";

	return (
		<Box flexDirection="column" marginY={0}>
			<Box>
				<Text color={color} bold>
					{icon} {title}
				</Text>
			</Box>
			{body && (
				<Box marginLeft={2}>
					<Text color="#9ca3af">{body}</Text>
				</Box>
			)}
		</Box>
	);
}

// ── StatusView (context token usage) ────────────────────────

export interface StatusViewProps {
	contextTokens: number;
	maxContextTokens: number;
	contextUsage?: number | null;
}

export function StatusView({
	contextTokens,
	maxContextTokens,
	contextUsage,
}: StatusViewProps) {
	const ratio = maxContextTokens > 0 ? contextTokens / maxContextTokens : 0;
	const percent = (ratio * 100).toFixed(0);
	const barWidth = 20;
	const filled = Math.round(ratio * barWidth);
	const empty = barWidth - filled;
	const color = ratio >= 0.9 ? "#ff7b72" : ratio >= 0.7 ? "#f2cc60" : "#56d364";

	return (
		<Box>
			<Text color="#6b7280">context </Text>
			<Text color={color}>{"█".repeat(filled)}</Text>
			<Text color="#3f3f46">{"░".repeat(empty)}</Text>
			<Text color="#6b7280">
				{" "}
				{percent}% ({(contextTokens / 1000).toFixed(1)}k/
				{(maxContextTokens / 1000).toFixed(1)}k)
			</Text>
		</Box>
	);
}

// ── PlanDisplayView ─────────────────────────────────────────

export function PlanDisplayView({
	content,
	filePath,
}: {
	content: string;
	filePath: string;
}) {
	const rendered = renderMarkdown(content);
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor="#56a4ff"
			paddingX={1}
			marginY={1}
		>
			<Box>
				<Text color="#56a4ff" bold>
					📋 Plan
				</Text>
				<Text color="#6b7280"> ({filePath})</Text>
			</Box>
			<Box flexDirection="column" marginTop={1}>
				{rendered}
			</Box>
		</Box>
	);
}

// ── HookView ────────────────────────────────────────────────

export function HookTriggeredView({
	event,
	target,
	hookCount,
}: {
	event: string;
	target: string;
	hookCount: number;
}) {
	return (
		<Box>
			<Text color="#6b7280">⟳ hook </Text>
			<Text color="#f2cc60">{event}</Text>
			{target && <Text color="#6b7280"> → {target}</Text>}
			{hookCount > 1 && <Text color="#6b7280"> ({hookCount} hooks)</Text>}
		</Box>
	);
}

export function HookResolvedView({
	event,
	target,
	action,
	reason,
	durationMs,
}: {
	event: string;
	target: string;
	action: string;
	reason: string;
	durationMs: number;
}) {
	const icon = action === "allow" ? "✓" : "✗";
	const color = action === "allow" ? "#56d364" : "#ff7b72";
	return (
		<Box>
			<Text color={color}>{icon} hook </Text>
			<Text color="#f2cc60">{event}</Text>
			{target && <Text color="#6b7280"> → {target}</Text>}
			<Text color="#6b7280">
				{" "}
				({action}
				{reason ? `: ${reason}` : ""}) {durationMs}ms
			</Text>
		</Box>
	);
}

// ── Enhanced DiffView with line numbers and context ─────────

function EnhancedDiffView({
	block,
}: {
	block: {
		path: string;
		old_text: string;
		new_text: string;
		old_start?: number;
		new_start?: number;
	};
}) {
	const diffColors = getDiffColors();
	const oldStart = block.old_start ?? 1;
	const newStart = block.new_start ?? 1;
	const oldLines = block.old_text.split("\n").filter(Boolean);
	const newLines = block.new_text.split("\n").filter(Boolean);

	// Determine max line number width for alignment
	const maxLineNum = Math.max(
		oldStart + oldLines.length,
		newStart + newLines.length,
	);
	const lineNumWidth = String(maxLineNum).length;

	// Build title: "+N path" for new file, "path" for edits
	const isNewFile = oldLines.length === 0 && newLines.length > 0;
	const title = isNewFile
		? ` +${newLines.length} ${block.path} `
		: ` ${block.path} `;

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor="#555555"
			paddingX={1}
		>
			<Text color="#e6e6e6" bold>
				{title}
			</Text>
			{oldLines.map((line, idx) => (
				<Text
					key={`old-${idx}`}
					color="#ff7b72"
					backgroundColor={diffColors.delBg}
				>
					{String(oldStart + idx).padStart(lineNumWidth)} - {line}
				</Text>
			))}
			{newLines.map((line, idx) => (
				<Text
					key={`new-${idx}`}
					color="#56d364"
					backgroundColor={diffColors.addBg}
				>
					{String(newStart + idx).padStart(lineNumWidth)} + {line}
				</Text>
			))}
		</Box>
	);
}

// ── Helpers ────────────────────────────────────────────────

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen)}…`;
}
