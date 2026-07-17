/**
 * useApproval hook — manages approval request state machine.
 * Corresponds to approval handling in Python's visualize.py.
 */

import { useState, useCallback } from "react";
import type { ApprovalRequest, ApprovalResponseKind } from "../../wire/types";

export interface ApprovalState {
	pending: ApprovalRequest | null;
	respond: (decision: ApprovalResponseKind, feedback?: string) => void;
	dismiss: () => void;
}

export interface UseApprovalOptions {
	onRespond?: (
		requestId: string,
		decision: ApprovalResponseKind,
		feedback?: string,
	) => void;
}

/**
 * Hook for managing approval request lifecycle.
 */
export function useApproval(options?: UseApprovalOptions): ApprovalState {
	const [pending, setPending] = useState<ApprovalRequest | null>(null);

	const respond = useCallback(
		(decision: ApprovalResponseKind, feedback?: string) => {
			if (!pending) return;
			options?.onRespond?.(pending.id, decision, feedback);
			setPending(null);
		},
		[pending, options],
	);

	const dismiss = useCallback(() => {
		setPending(null);
	}, []);

	return { pending, respond, dismiss };
}

/**
 * Set the pending approval from external source (e.g., wire events).
 * This is used by the Shell to inject approval requests into the hook.
 */
export function createApprovalManager(options?: UseApprovalOptions) {
	let _pending: ApprovalRequest | null = null;
	let _setPending: ((req: ApprovalRequest | null) => void) | null = null;

	return {
		setPendingRef: (setter: (req: ApprovalRequest | null) => void) => {
			_setPending = setter;
		},
		enqueue: (request: ApprovalRequest) => {
			_pending = request;
			_setPending?.(request);
		},
		clear: () => {
			_pending = null;
			_setPending?.(null);
		},
	};
}
