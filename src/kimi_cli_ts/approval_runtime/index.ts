/**
 * Approval runtime — corresponds to Python approval_runtime/__init__.py
 * Re-exports from models.ts and runtime.ts.
 */

export {
	type ApprovalResponseKind,
	type ApprovalSourceKind,
	type ApprovalStatus,
	type ApprovalRuntimeEventKind,
	type ApprovalSource,
	type ApprovalRequestRecord,
	type ApprovalRuntimeEvent,
} from "./models.ts";

export {
	ApprovalCancelledError,
	ApprovalRuntime,
	getCurrentApprovalSourceOrNull,
	setCurrentApprovalSource,
	runWithApprovalSource,
	runWithApprovalSourceAsync,
	type EventSubscriber,
} from "./runtime.ts";
