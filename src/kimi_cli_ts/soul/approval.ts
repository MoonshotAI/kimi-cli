/**
 * Approval system — corresponds to Python soul/approval.py
 * High-level approval request/response logic used by tools.
 */

import { randomUUID } from "node:crypto";
import {
	ApprovalRuntime,
	ApprovalCancelledError,
	getCurrentApprovalSourceOrNull,
	type ApprovalResponseKind,
	type ApprovalSource,
} from "../approval_runtime/index.ts";

// ── ApprovalResult ──────────────────────────────────────

export class ApprovalResult {
	readonly approved: boolean;
	readonly feedback: string;

	constructor(approved: boolean, feedback = "") {
		this.approved = approved;
		this.feedback = feedback;
	}

	/** Allow `if (result)` / `if (!result)` usage. */
	valueOf(): boolean {
		return this.approved;
	}
}

// ── ApprovalState ───────────────────────────────────────

export class ApprovalState {
	yolo: boolean;
	autoApproveActions: Set<string>;
	private onChange?: () => void;

	constructor(opts?: {
		yolo?: boolean;
		autoApproveActions?: Set<string>;
		onChange?: () => void;
	}) {
		this.yolo = opts?.yolo ?? false;
		this.autoApproveActions = opts?.autoApproveActions ?? new Set();
		this.onChange = opts?.onChange;
	}

	notifyChange(): void {
		this.onChange?.();
	}
}

// ── Approval ────────────────────────────────────────────

export class Approval {
	private state: ApprovalState;
	private _runtime: ApprovalRuntime;

	constructor(opts?: {
		yolo?: boolean;
		state?: ApprovalState;
		runtime?: ApprovalRuntime;
	}) {
		this.state = opts?.state ?? new ApprovalState({ yolo: opts?.yolo });
		this._runtime = opts?.runtime ?? new ApprovalRuntime();
	}

	/** Create a new Approval that shares state (yolo + auto-approve). */
	share(): Approval {
		return new Approval({ state: this.state, runtime: this._runtime });
	}

	get runtime(): ApprovalRuntime {
		return this._runtime;
	}

	setRuntime(runtime: ApprovalRuntime): void {
		this._runtime = runtime;
	}

	setYolo(yolo: boolean): void {
		this.state.yolo = yolo;
		this.state.notifyChange();
	}

	isYolo(): boolean {
		return this.state.yolo;
	}

	async request(
		sender: string,
		action: string,
		description: string,
		opts?: {
			toolCallId?: string;
			display?: unknown[];
			source?: ApprovalSource;
		},
	): Promise<ApprovalResult> {
		const toolCallId = opts?.toolCallId ?? randomUUID();
		// Read approval source from AsyncLocalStorage context (set by subagent runner),
		// fall back to explicit opts.source, then default.
		// Mirrors Python: get_current_approval_source_or_none() or ApprovalSource(...)
		const source: ApprovalSource = opts?.source ??
			getCurrentApprovalSourceOrNull() ?? {
				kind: "foreground_turn",
				id: toolCallId,
			};

		if (this.state.yolo) return new ApprovalResult(true);
		if (this.state.autoApproveActions.has(action))
			return new ApprovalResult(true);

		const requestId = randomUUID();
		this._runtime.createRequest({
			requestId,
			toolCallId,
			sender,
			action,
			description,
			display: opts?.display,
			source,
		});

		try {
			const [response, feedback] =
				await this._runtime.waitForResponse(requestId);
			switch (response) {
				case "approve":
					return new ApprovalResult(true);
				case "approve_for_session":
					this.state.autoApproveActions.add(action);
					this.state.notifyChange();
					// Auto-approve other pending requests for the same action
					for (const pending of this._runtime.listPending()) {
						if (pending.action === action) {
							this._runtime.resolve(pending.id, "approve");
						}
					}
					return new ApprovalResult(true);
				case "reject":
					return new ApprovalResult(false, feedback);
			}
		} catch (err) {
			if (err instanceof ApprovalCancelledError) {
				return new ApprovalResult(false);
			}
			throw err;
		}
	}
}
