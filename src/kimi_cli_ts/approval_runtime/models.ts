/**
 * Approval runtime models — corresponds to Python approval_runtime/models.py
 * Data types for approval requests, sources, and events.
 */

// ── Types ───────────────────────────────────────────────

export type ApprovalResponseKind = "approve" | "approve_for_session" | "reject";
export type ApprovalSourceKind = "foreground_turn" | "background_agent";
export type ApprovalStatus = "pending" | "resolved" | "cancelled";
export type ApprovalRuntimeEventKind = "request_created" | "request_resolved";

export interface ApprovalSource {
	kind: ApprovalSourceKind;
	id: string;
	agentId?: string;
	subagentType?: string;
}

export interface ApprovalRequestRecord {
	id: string;
	toolCallId: string;
	sender: string;
	action: string;
	description: string;
	display: unknown[];
	source: ApprovalSource;
	createdAt: number;
	status: ApprovalStatus;
	resolvedAt: number | null;
	response: ApprovalResponseKind | null;
	feedback: string;
}

export interface ApprovalRuntimeEvent {
	kind: ApprovalRuntimeEventKind;
	request: ApprovalRequestRecord;
}
