/**
 * ApprovalPanel.tsx — Approval request panel built on SelectionPanel.
 * Corresponds to Python's ui/shell/approval_panel.py.
 *
 * This is a thin wrapper that configures SelectionPanel with the 4 approval
 * options and renders the request header / content preview above them.
 */

import React, { useRef } from "react";
import { Box, Text } from "ink";
import { SelectionPanel } from "./SelectionPanel.tsx";
import type { SelectionOption } from "./SelectionPanel.tsx";
import type {
	ApprovalRequest,
	ApprovalResponseKind,
	DisplayBlock,
	DiffDisplayBlock,
	ShellDisplayBlock,
	BriefDisplayBlock,
} from "../../wire/types";

const MAX_PREVIEW_LINES = 4;

const APPROVAL_OPTIONS: SelectionOption[] = [
	{ label: "Approve once" },
	{ label: "Approve for this session" },
	{ label: "Reject" },
	{
		label: "Reject, tell the model what to do instead",
		inputMode: true,
		inputPrefix: "Reject: ",
	},
];

const RESPONSE_MAP: ApprovalResponseKind[] = [
	"approve",
	"approve_for_session",
	"reject",
	"reject",
];

// ── DiffPreview ──────────────────────────────────────────

function DiffPreview({ blocks }: { blocks: DisplayBlock[] }) {
	const diffBlocks = blocks.filter(
		(b): b is DiffDisplayBlock => b.type === "diff",
	);
	if (diffBlocks.length === 0) return null;

	const byPath = new Map<string, DiffDisplayBlock[]>();
	for (const block of diffBlocks) {
		const existing = byPath.get(block.path) || [];
		existing.push(block);
		byPath.set(block.path, existing);
	}

	return (
		<Box flexDirection="column">
			{[...byPath.entries()].map(([path, diffs]) => (
				<Box key={path} flexDirection="column">
					<Text color="cyan" bold>
						{path}
					</Text>
					{diffs.map((diff, idx) => (
						<Box key={idx} flexDirection="column">
							{diff.old_text
								.split("\n")
								.slice(0, MAX_PREVIEW_LINES)
								.map((line, lineIdx) => (
									<Text key={`old-${lineIdx}`} color="#ff7b72">
										- {line}
									</Text>
								))}
							{diff.new_text
								.split("\n")
								.slice(0, MAX_PREVIEW_LINES)
								.map((line, lineIdx) => (
									<Text key={`new-${lineIdx}`} color="#56d364">
										+ {line}
									</Text>
								))}
						</Box>
					))}
				</Box>
			))}
		</Box>
	);
}

// ── ContentPreview ───────────────────────────────────────

function ContentPreview({
	blocks,
	truncatedRef,
}: {
	blocks: DisplayBlock[];
	truncatedRef: React.MutableRefObject<boolean>;
}) {
	let budget = MAX_PREVIEW_LINES;
	let truncated = false;
	const elements: React.ReactNode[] = [];

	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		if (budget <= 0) {
			truncated = true;
			break;
		}
		if (!block) continue;

		if (block.type === "shell") {
			const shellBlock = block as ShellDisplayBlock;
			const lines = shellBlock.command.trim().split("\n");
			const showLines = lines.slice(0, budget);
			if (lines.length > budget) truncated = true;
			budget -= showLines.length;
			elements.push(<Text key={`shell-${i}`}>{showLines.join("\n")}</Text>);
		} else if (block.type === "brief") {
			const briefBlock = block as BriefDisplayBlock;
			const lines = briefBlock.brief.trim().split("\n");
			const showLines = lines.slice(0, budget);
			if (lines.length > budget) truncated = true;
			budget -= showLines.length;
			elements.push(
				<Text key={`brief-${i}`} color="grey" italic>
					{showLines.join("\n")}
				</Text>,
			);
		}
	}

	truncatedRef.current = truncated;

	return (
		<Box flexDirection="column">
			{elements}
			{truncated && (
				<Text dimColor italic>
					... (truncated, ctrl-e to expand)
				</Text>
			)}
		</Box>
	);
}

// ── ApprovalPanel ────────────────────────────────────────

export interface ApprovalPanelProps {
	request: ApprovalRequest;
	onRespond: (decision: ApprovalResponseKind, feedback?: string) => void;
}

export function ApprovalPanel({ request, onRespond }: ApprovalPanelProps) {
	const nonDiffTruncatedRef = useRef(false);

	const hasDiff = request.display.some((b) => b.type === "diff");
	const hasNonDiffBlocks = request.display.some(
		(b) => b.type === "shell" || b.type === "brief",
	);
	const hasExpandableContent = hasDiff || nonDiffTruncatedRef.current;

	return (
		<SelectionPanel
			options={APPROVAL_OPTIONS}
			onSelect={(idx) => onRespond(RESPONSE_MAP[idx]!)}
			onInputSubmit={(_idx, text) => onRespond("reject", text)}
			onCancel={() => onRespond("reject")}
			borderColor="yellow"
			title="⚠ ACTION REQUIRED"
			extraHint={hasExpandableContent ? "  ctrl-e expand" : ""}
		>
			{/* Request header */}
			<Box paddingLeft={1} flexDirection="column">
				<Text color="yellow">
					{request.sender} is requesting approval to {request.action}:
				</Text>
				{(request.subagent_type || request.agent_id) && (
					<Text color="grey">
						Subagent:{" "}
						{request.subagent_type && request.agent_id
							? `${request.subagent_type} (${request.agent_id})`
							: request.subagent_type || request.agent_id}
					</Text>
				)}
				{request.source_description && (
					<Text color="grey">Task: {request.source_description}</Text>
				)}
			</Box>

			{/* Description (only if no display blocks) */}
			{request.description && !request.display.length && (
				<>
					<Text> </Text>
					<Box paddingLeft={1}>
						<Text>{truncateLines(request.description, MAX_PREVIEW_LINES)}</Text>
					</Box>
				</>
			)}

			{/* Diff preview */}
			{hasDiff && (
				<>
					<Text> </Text>
					<Box paddingLeft={1}>
						<DiffPreview blocks={request.display} />
					</Box>
				</>
			)}

			{/* Non-diff content preview */}
			{hasNonDiffBlocks && (
				<>
					<Text> </Text>
					<Box paddingLeft={1}>
						<ContentPreview
							blocks={request.display}
							truncatedRef={nonDiffTruncatedRef}
						/>
					</Box>
				</>
			)}
		</SelectionPanel>
	);
}

// ── Helpers ──────────────────────────────────────────────

function truncateLines(text: string, maxLines: number): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	return lines.slice(0, maxLines).join("\n") + "\n...";
}

export default ApprovalPanel;
