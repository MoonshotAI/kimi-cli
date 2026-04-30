/**
 * Approval runtime — corresponds to Python approval_runtime/runtime.py
 * Manages approval requests lifecycle: create, wait, resolve, cancel.
 */

import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../utils/logging.ts";
import type { RootWireHub } from "../wire/root_hub.ts";
import type {
	ApprovalRequest as WireApprovalRequest,
	ApprovalResponse as WireApprovalResponse,
} from "../wire/types.ts";
import type {
	ApprovalRequestRecord,
	ApprovalResponseKind,
	ApprovalRuntimeEvent,
	ApprovalSource,
	ApprovalSourceKind,
} from "./models.ts";

// ── Errors ──────────────────────────────────────────────

export class ApprovalCancelledError extends Error {
	constructor(requestId: string) {
		super(`Approval cancelled: ${requestId}`);
		this.name = "ApprovalCancelledError";
	}
}

// ── Approval Source Context (ContextVar equivalent) ─────

const _approvalSourceStorage = new AsyncLocalStorage<ApprovalSource | null>();

export function getCurrentApprovalSourceOrNull(): ApprovalSource | null {
	return _approvalSourceStorage.getStore() ?? null;
}

export function setCurrentApprovalSource(source: ApprovalSource): void {
	// Note: AsyncLocalStorage manages context automatically via run().
	// For imperative set/reset, we store on the current context.
	const store = _approvalSourceStorage.getStore();
	if (store !== undefined) {
		// We're inside a run() context — callers should use runWithApprovalSource instead
		logger.warn("setCurrentApprovalSource called inside existing context");
	}
}

/**
 * Run a callback with the given approval source set as the current context.
 * Equivalent to Python's ContextVar set/reset pattern.
 */
export function runWithApprovalSource<T>(
	source: ApprovalSource,
	fn: () => T,
): T {
	return _approvalSourceStorage.run(source, fn);
}

/**
 * Run an async callback with the given approval source set as the current context.
 */
export async function runWithApprovalSourceAsync<T>(
	source: ApprovalSource,
	fn: () => Promise<T>,
): Promise<T> {
	return _approvalSourceStorage.run(source, fn);
}

// ── Waiter (promise-based future) ───────────────────────

interface Waiter {
	resolve: (value: [ApprovalResponseKind, string]) => void;
	reject: (reason: Error) => void;
	promise: Promise<[ApprovalResponseKind, string]>;
}

function createWaiter(): Waiter {
	let resolve!: Waiter["resolve"];
	let reject!: Waiter["reject"];
	const promise = new Promise<[ApprovalResponseKind, string]>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { resolve, reject, promise };
}

// ── Runtime ─────────────────────────────────────────────

export type EventSubscriber = (event: ApprovalRuntimeEvent) => void;

export class ApprovalRuntime {
	private requests = new Map<string, ApprovalRequestRecord>();
	private waiters = new Map<string, Waiter>();
	private subscribers = new Map<string, EventSubscriber>();
	private _rootWireHub: RootWireHub | null = null;

	/** Bind a root wire hub for broadcasting approval events to UI. */
	bindRootWireHub(rootWireHub: RootWireHub): void {
		if (this._rootWireHub === rootWireHub) return;
		this._rootWireHub = rootWireHub;
	}

	createRequest(opts: {
		requestId?: string;
		toolCallId: string;
		sender: string;
		action: string;
		description: string;
		display?: unknown[];
		source: ApprovalSource;
	}): ApprovalRequestRecord {
		const request: ApprovalRequestRecord = {
			id: opts.requestId ?? randomUUID(),
			toolCallId: opts.toolCallId,
			sender: opts.sender,
			action: opts.action,
			description: opts.description,
			display: opts.display ?? [],
			source: opts.source,
			createdAt: Date.now() / 1000,
			status: "pending",
			resolvedAt: null,
			response: null,
			feedback: "",
		};
		this.requests.set(request.id, request);
		this.publishEvent({ kind: "request_created", request });
		this._publishWireRequest(request);
		return request;
	}

	async waitForResponse(
		requestId: string,
		timeout: number = 300_000,
	): Promise<[ApprovalResponseKind, string]> {
		const request = this.requests.get(requestId);
		if (!request) throw new Error(`Approval request not found: ${requestId}`);

		if (request.status === "cancelled") {
			throw new ApprovalCancelledError(requestId);
		}
		if (request.status === "resolved" && request.response) {
			return [request.response, request.feedback];
		}

		let waiter = this.waiters.get(requestId);
		if (!waiter) {
			waiter = createWaiter();
			this.waiters.set(requestId, waiter);
		}

		// Race the waiter against a timeout to prevent hanging forever
		const timeoutPromise = new Promise<never>((_, reject) => {
			const timer = setTimeout(() => {
				reject(new Error("timeout"));
			}, timeout);
			// Don't hold the process open for this timer
			if (typeof timer === "object" && "unref" in timer) {
				timer.unref();
			}
		});

		try {
			return await Promise.race([waiter.promise, timeoutPromise]);
		} catch (err) {
			if (err instanceof Error && err.message === "timeout") {
				logger.warn(
					`Approval request ${requestId} timed out after ${timeout}ms`,
				);
				// Pop the waiter before cancelling so _cancelRequest won't
				// reject a future that nobody is awaiting (which would trigger
				// an "unhandled rejection" warning).
				this.waiters.delete(requestId);
				this._cancelRequest(requestId, "approval timed out");
				throw new ApprovalCancelledError(requestId);
			}
			throw err;
		}
	}

	resolve(
		requestId: string,
		response: ApprovalResponseKind,
		feedback = "",
	): boolean {
		const request = this.requests.get(requestId);
		if (!request || request.status !== "pending") return false;

		request.status = "resolved";
		request.response = response;
		request.feedback = feedback;
		request.resolvedAt = Date.now() / 1000;

		const waiter = this.waiters.get(requestId);
		if (waiter) {
			waiter.resolve([response, feedback]);
			this.waiters.delete(requestId);
		}
		this.publishEvent({ kind: "request_resolved", request });
		this._publishWireResponse(requestId, response, feedback);
		return true;
	}

	/** Cancel a single pending request by ID. */
	private _cancelRequest(requestId: string, feedback = ""): void {
		const request = this.requests.get(requestId);
		if (!request || request.status !== "pending") return;

		request.status = "cancelled";
		request.response = "reject";
		request.feedback = feedback;
		request.resolvedAt = Date.now() / 1000;

		const waiter = this.waiters.get(requestId);
		if (waiter) {
			waiter.reject(new ApprovalCancelledError(requestId));
			this.waiters.delete(requestId);
		}
		this.publishEvent({ kind: "request_resolved", request });
		this._publishWireResponse(requestId, "reject", feedback);
	}

	cancelBySource(sourceKind: ApprovalSourceKind, sourceId: string): number {
		let cancelled = 0;
		for (const [requestId, request] of this.requests) {
			if (request.status !== "pending") continue;
			if (request.source.kind !== sourceKind || request.source.id !== sourceId)
				continue;

			request.status = "cancelled";
			request.response = "reject";
			request.resolvedAt = Date.now() / 1000;

			const waiter = this.waiters.get(requestId);
			if (waiter) {
				waiter.reject(new ApprovalCancelledError(requestId));
				this.waiters.delete(requestId);
			}
			this.publishEvent({ kind: "request_resolved", request });
			this._publishWireResponse(requestId, "reject");
			cancelled++;
		}
		return cancelled;
	}

	listPending(): ApprovalRequestRecord[] {
		return [...this.requests.values()]
			.filter((r) => r.status === "pending")
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	getRequest(requestId: string): ApprovalRequestRecord | undefined {
		return this.requests.get(requestId);
	}

	subscribe(callback: EventSubscriber): string {
		const token = randomUUID();
		this.subscribers.set(token, callback);
		return token;
	}

	unsubscribe(token: string): void {
		this.subscribers.delete(token);
	}

	private publishEvent(event: ApprovalRuntimeEvent): void {
		for (const cb of this.subscribers.values()) {
			try {
				cb(event);
			} catch (err) {
				logger.error("Approval runtime event subscriber failed", err);
			}
		}
	}

	private _publishWireRequest(request: ApprovalRequestRecord): void {
		if (!this._rootWireHub) return;
		this._rootWireHub.publishNowait({
			__wireType: "ApprovalRequest",
			id: request.id,
			tool_call_id: request.toolCallId,
			sender: request.sender,
			action: request.action,
			description: request.description,
			display: request.display,
			source_kind: request.source.kind,
			source_id: request.source.id,
			agent_id: request.source.agentId ?? null,
			subagent_type: request.source.subagentType ?? null,
			source_description: null,
		} as unknown as WireApprovalRequest);
	}

	private _publishWireResponse(
		requestId: string,
		response: ApprovalResponseKind,
		feedback = "",
	): void {
		if (!this._rootWireHub) return;
		this._rootWireHub.publishNowait({
			__wireType: "ApprovalResponse",
			request_id: requestId,
			response,
			feedback,
		} as unknown as WireApprovalResponse);
	}
}
