/**
 * ACP tool replacements — corresponds to Python acp/tools.py
 * Replaces Shell tool with Terminal tool when ACP client supports terminal.
 */

import { z } from "zod/v4";
import { CallableTool } from "../tools/base.ts";
import { ToolResultBuilder } from "../tools/types.ts";
import type { ToolContext, ToolResult } from "../tools/types.ts";
import { ToolRejectedError } from "../tools/types.ts";
import { Shell } from "../tools/shell/index.ts";
import type { KimiToolset } from "../soul/toolset.ts";
import type { Runtime } from "../soul/agent.ts";
import type { Approval } from "../soul/approval.ts";
import type { ACPClient } from "./kaos.ts";
import type {
	ClientCapabilities,
	TerminalToolCallContent,
	ToolCallProgress,
} from "./types.ts";
import { logger } from "../utils/logging.ts";

const _DEFAULT_OUTPUT_BYTE_LIMIT = 50_000;

/**
 * A special display block type that indicates output should be hidden in ACP clients.
 * Corresponds to Python HideOutputDisplayBlock.
 */
export const HIDE_OUTPUT_DISPLAY_BLOCK = { type: "acp/hide_output" as const };

/**
 * Replace tools in the toolset when running under ACP.
 * Swaps Shell tool with Terminal when client supports terminal.
 * Corresponds to Python replace_tools().
 */
export function replaceTools(
	clientCapabilities: ClientCapabilities,
	acpClient: ACPClient,
	acpSessionId: string,
	toolset: KimiToolset,
	runtime: Runtime,
): void {
	if (clientCapabilities.terminal) {
		const shellTool = toolset.find("Shell");
		if (shellTool instanceof Shell) {
			const terminal = new Terminal(
				shellTool,
				acpClient,
				acpSessionId,
				runtime.approval,
			);
			toolset.add(terminal);
			logger.debug("Replaced Shell tool with ACP Terminal tool");
		}
	}
}

// ── Terminal tool ──────────────────────────────────────────

const TerminalParamsSchema = z.object({
	command: z.string().describe("The command to execute."),
	timeout: z
		.number()
		.int()
		.min(1)
		.max(24 * 60 * 60)
		.default(60)
		.describe("The timeout in seconds for the command to execute."),
	run_in_background: z
		.boolean()
		.default(false)
		.describe("Whether to run the command as a background task."),
	description: z
		.string()
		.default("")
		.describe("A short description for the background task."),
});

type TerminalParams = z.infer<typeof TerminalParamsSchema>;

/**
 * ACP Terminal tool — executes commands via ACP terminal protocol.
 * Replaces the Shell tool when running under ACP with terminal support.
 * Corresponds to Python Terminal class.
 */
export class Terminal extends CallableTool<typeof TerminalParamsSchema> {
	readonly name: string;
	readonly description: string;
	readonly schema = TerminalParamsSchema;

	private _acpClient: ACPClient;
	private _acpSessionId: string;
	private _approval: Approval;

	constructor(
		shellTool: Shell,
		acpClient: ACPClient,
		acpSessionId: string,
		approval: Approval,
	) {
		super();
		this.name = shellTool.name;
		this.description = shellTool.description;
		this._acpClient = acpClient;
		this._acpSessionId = acpSessionId;
		this._approval = approval;
	}

	async execute(params: TerminalParams, ctx: ToolContext): Promise<ToolResult> {
		const builder = new ToolResultBuilder();
		// Hide tool output because we use TerminalToolCallContent which already streams output
		builder.display(HIDE_OUTPUT_DISPLAY_BLOCK);

		if (!params.command) {
			return builder.error("Command cannot be empty.");
		}

		const approvalResult = await this._approval.request(
			this.name,
			"run shell command",
			`Run command \`${params.command}\``,
		);
		if (!approvalResult.approved) {
			return new ToolRejectedError({
				message: approvalResult.feedback
					? `The tool call is rejected by the user. User feedback: ${approvalResult.feedback}`
					: undefined,
				brief: approvalResult.feedback
					? `Rejected: ${approvalResult.feedback}`
					: "Rejected by user",
				hasFeedback: !!approvalResult.feedback,
			}).toToolResult();
		}

		const timeoutSeconds = params.timeout;
		const timeoutLabel = `${timeoutSeconds}s`;
		let terminalId: string | null = null;
		let exitStatus: {
			exit_code: number | null;
			signal?: string | null;
		} | null = null;
		let timedOut = false;

		try {
			const resp = await this._acpClient.createTerminal({
				command: params.command,
				sessionId: this._acpSessionId,
				outputByteLimit: _DEFAULT_OUTPUT_BYTE_LIMIT,
			});
			terminalId = resp.terminalId;

			// Send terminal tool call content to ACP client
			const acpToolCallId = getCurrentAcpToolCallIdOrNull();
			if (acpToolCallId) {
				const update: ToolCallProgress = {
					session_update: "tool_call_update",
					tool_call_id: acpToolCallId,
					status: "in_progress",
					content: [
						{
							type: "terminal",
							terminal_id: terminalId,
						} as TerminalToolCallContent,
					],
				};
				await this._acpClient.sessionUpdate({
					sessionId: this._acpSessionId,
					update,
				});
			}

			// Wait for terminal exit with timeout
			try {
				const exitPromise = this._acpClient.waitForTerminalExit({
					sessionId: this._acpSessionId,
					terminalId,
				});
				const timeoutPromise = new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("timeout")), timeoutSeconds * 1000),
				);
				exitStatus = await Promise.race([exitPromise, timeoutPromise]);
			} catch (e) {
				if (e instanceof Error && e.message === "timeout") {
					timedOut = true;
					await this._acpClient.killTerminal({
						sessionId: this._acpSessionId,
						terminalId,
					});
				} else {
					throw e;
				}
			}

			// Get final output
			const outputResponse = await this._acpClient.terminalOutput({
				sessionId: this._acpSessionId,
				terminalId,
			});
			builder.write(outputResponse.output);
			if (outputResponse.exit_status) {
				exitStatus = outputResponse.exit_status;
			}

			const exitCode = exitStatus?.exit_code ?? null;
			const exitSignal = (exitStatus as any)?.signal ?? null;

			const truncatedNote = outputResponse.truncated
				? " Output was truncated by the client output limit."
				: "";

			if (timedOut) {
				return builder.error(
					`Command killed by timeout (${timeoutLabel})${truncatedNote}`,
				);
			}
			if (exitSignal) {
				return builder.error(
					`Command terminated by signal: ${exitSignal}.${truncatedNote}`,
				);
			}
			if (exitCode !== null && exitCode !== 0) {
				return builder.error(
					`Command failed with exit code: ${exitCode}.${truncatedNote}`,
				);
			}
			return builder.ok(`Command executed successfully.${truncatedNote}`);
		} finally {
			if (terminalId !== null) {
				try {
					await this._acpClient.releaseTerminal({
						sessionId: this._acpSessionId,
						terminalId,
					});
				} catch {
					// ignore
				}
			}
		}
	}
}

// ── Context helpers ────────────────────────────────────────

/** Global variable to track current ACP tool call ID (set by ACPSession). */
let _currentAcpToolCallId: string | null = null;

export function setCurrentAcpToolCallId(id: string | null): void {
	_currentAcpToolCallId = id;
}

export function getCurrentAcpToolCallIdOrNull(): string | null {
	return _currentAcpToolCallId;
}
