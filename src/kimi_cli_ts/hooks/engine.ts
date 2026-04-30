/**
 * Hook engine — corresponds to Python hooks/engine.py
 * Runs matching hooks (shell commands) in parallel on lifecycle events.
 */

import type { HookDef, HookEventType } from "./config.ts";
import { logger } from "../utils/logging.ts";

// ── Types ───────────────────────────────────────────────

export interface HookResult {
	action: "allow" | "block";
	reason: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	timedOut?: boolean;
}

export interface WireHookSubscription {
	id: string;
	event: string;
	matcher: string;
	timeout: number;
}

export type OnTriggered = (
	event: string,
	target: string,
	hookCount: number,
) => void;
export type OnResolved = (
	event: string,
	target: string,
	action: string,
	reason: string,
	durationMs: number,
) => void;
export type OnWireHookRequest = (handle: WireHookHandle) => Promise<void>;

// ── Wire hook handle ────────────────────────────────────

let _handleIdCounter = 0;

export class WireHookHandle {
	readonly id: string;
	readonly subscriptionId: string;
	readonly event: string;
	readonly target: string;
	readonly inputData: Record<string, unknown>;

	private _resolve?: (result: HookResult) => void;
	private _promise: Promise<HookResult>;

	constructor(opts: {
		subscriptionId: string;
		event: string;
		target: string;
		inputData: Record<string, unknown>;
	}) {
		this.id = `wh${(++_handleIdCounter).toString(36)}`;
		this.subscriptionId = opts.subscriptionId;
		this.event = opts.event;
		this.target = opts.target;
		this.inputData = opts.inputData;
		this._promise = new Promise<HookResult>((resolve) => {
			this._resolve = resolve;
		});
	}

	wait(): Promise<HookResult> {
		return this._promise;
	}

	resolve(action: "allow" | "block" = "allow", reason = ""): void {
		this._resolve?.({ action, reason });
	}
}

// ── Hook runner ─────────────────────────────────────────

async function runHook(
	command: string,
	inputData: Record<string, unknown>,
	opts?: { timeout?: number; cwd?: string },
): Promise<HookResult> {
	const timeout = (opts?.timeout ?? 30) * 1000;
	try {
		const proc = Bun.spawn(["sh", "-c", command], {
			stdin: new Blob([JSON.stringify(inputData)]),
			stdout: "pipe",
			stderr: "pipe",
			cwd: opts?.cwd,
		});

		const timer = setTimeout(() => proc.kill(), timeout);

		const exitCode = await proc.exited;
		clearTimeout(timer);

		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();

		// Exit 2 = block
		if (exitCode === 2) {
			return {
				action: "block",
				reason: stderr.trim(),
				stdout,
				stderr,
				exitCode: 2,
			};
		}

		// Exit 0 + JSON stdout = structured decision
		if (exitCode === 0 && stdout.trim()) {
			try {
				const parsed = JSON.parse(stdout.trim());
				if (parsed && typeof parsed === "object") {
					// Direct action field (e.g. {"action":"block","reason":"..."})
					if (parsed.action === "block") {
						return {
							action: "block",
							reason: String(parsed.reason ?? ""),
							stdout,
							stderr,
							exitCode: 0,
						};
					}
					// Claude Code-style hookSpecificOutput
					const hookOutput = parsed.hookSpecificOutput;
					if (hookOutput?.permissionDecision === "deny") {
						return {
							action: "block",
							reason: String(hookOutput.permissionDecisionReason ?? ""),
							stdout,
							stderr,
							exitCode: 0,
						};
					}
				}
			} catch {
				// Not JSON — that's fine
			}
		}

		return {
			action: "allow",
			reason: "",
			stdout,
			stderr,
			exitCode: exitCode ?? 0,
		};
	} catch {
		return { action: "allow", reason: "" };
	}
}

// ── Engine ──────────────────────────────────────────────

export class HookEngine {
	private hooks: HookDef[];
	private wireSubs: WireHookSubscription[] = [];
	private cwd?: string;
	private onTriggered?: OnTriggered;
	private onResolved?: OnResolved;
	private onWireHook?: OnWireHookRequest;
	private byEvent = new Map<string, HookDef[]>();
	private wireByEvent = new Map<string, WireHookSubscription[]>();

	constructor(opts?: {
		hooks?: HookDef[];
		cwd?: string;
		onTriggered?: OnTriggered;
		onResolved?: OnResolved;
		onWireHook?: OnWireHookRequest;
	}) {
		this.hooks = opts?.hooks ? [...opts.hooks] : [];
		this.cwd = opts?.cwd;
		this.onTriggered = opts?.onTriggered;
		this.onResolved = opts?.onResolved;
		this.onWireHook = opts?.onWireHook;
		this.rebuildIndex();
	}

	private rebuildIndex(): void {
		this.byEvent.clear();
		for (const h of this.hooks) {
			const list = this.byEvent.get(h.event) ?? [];
			list.push(h);
			this.byEvent.set(h.event, list);
		}
		this.wireByEvent.clear();
		for (const s of this.wireSubs) {
			const list = this.wireByEvent.get(s.event) ?? [];
			list.push(s);
			this.wireByEvent.set(s.event, list);
		}
	}

	addHooks(hooks: HookDef[]): void {
		this.hooks.push(...hooks);
		this.rebuildIndex();
	}

	addWireSubscriptions(subs: WireHookSubscription[]): void {
		this.wireSubs.push(...subs);
		this.rebuildIndex();
	}

	setCallbacks(opts: {
		onTriggered?: OnTriggered;
		onResolved?: OnResolved;
		onWireHook?: OnWireHookRequest;
	}): void {
		this.onTriggered = opts.onTriggered;
		this.onResolved = opts.onResolved;
		this.onWireHook = opts.onWireHook;
	}

	get hasHooks(): boolean {
		return this.hooks.length > 0 || this.wireSubs.length > 0;
	}

	hasHooksFor(event: HookEventType): boolean {
		return (
			(this.byEvent.get(event)?.length ?? 0) > 0 ||
			(this.wireByEvent.get(event)?.length ?? 0) > 0
		);
	}

	get summary(): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const [event, hooks] of this.byEvent) {
			counts[event] = (counts[event] ?? 0) + hooks.length;
		}
		for (const [event, subs] of this.wireByEvent) {
			counts[event] = (counts[event] ?? 0) + subs.length;
		}
		return counts;
	}

	private matchRegex(pattern: string, value: string): boolean {
		if (!pattern) return true;
		try {
			return new RegExp(pattern).test(value);
		} catch {
			logger.warn(`Invalid regex in hook matcher: ${pattern}`);
			return false;
		}
	}

	async trigger(
		event: HookEventType,
		opts: { matcherValue?: string; inputData: Record<string, unknown> },
	): Promise<HookResult[]> {
		const matcherValue = opts.matcherValue ?? "";

		// Match server-side hooks
		const seenCommands = new Set<string>();
		const serverMatched: HookDef[] = [];
		for (const h of this.byEvent.get(event) ?? []) {
			if (!this.matchRegex(h.matcher, matcherValue)) continue;
			if (seenCommands.has(h.command)) continue;
			seenCommands.add(h.command);
			serverMatched.push(h);
		}

		// Match wire subscriptions
		const wireMatched: WireHookSubscription[] = [];
		for (const s of this.wireByEvent.get(event) ?? []) {
			if (!this.matchRegex(s.matcher, matcherValue)) continue;
			wireMatched.push(s);
		}

		const total = serverMatched.length + wireMatched.length;
		if (total === 0) return [];

		try {
			return await this.executeHooks(
				event,
				matcherValue,
				serverMatched,
				wireMatched,
				opts.inputData,
			);
		} catch {
			logger.warn(`Hook engine error for ${event}, failing open`);
			return [];
		}
	}

	private async executeHooks(
		event: string,
		matcherValue: string,
		serverMatched: HookDef[],
		wireMatched: WireHookSubscription[],
		inputData: Record<string, unknown>,
	): Promise<HookResult[]> {
		const total = serverMatched.length + wireMatched.length;

		if (this.onTriggered) {
			try {
				this.onTriggered(event, matcherValue, total);
			} catch {
				// ignore
			}
		}

		const t0 = performance.now();

		// Server-side: run shell commands
		const tasks: Promise<HookResult>[] = serverMatched.map((h) =>
			runHook(h.command, inputData, { timeout: h.timeout, cwd: this.cwd }),
		);

		// Wire-side: dispatch to client
		for (const s of wireMatched) {
			tasks.push(
				this.dispatchWireHook(s.id, event, matcherValue, inputData, s.timeout),
			);
		}

		const results = await Promise.all(tasks);
		const durationMs = Math.round(performance.now() - t0);

		let action = "allow";
		let reason = "";
		for (const r of results) {
			if (r.action === "block") {
				action = "block";
				reason = r.reason;
				break;
			}
		}

		if (this.onResolved) {
			try {
				this.onResolved(event, matcherValue, action, reason, durationMs);
			} catch {
				// ignore
			}
		}

		return results;
	}

	private async dispatchWireHook(
		subscriptionId: string,
		event: string,
		target: string,
		inputData: Record<string, unknown>,
		timeout: number = 30,
	): Promise<HookResult> {
		if (!this.onWireHook) {
			return { action: "allow", reason: "" };
		}

		const handle = new WireHookHandle({
			subscriptionId,
			event,
			target,
			inputData,
		});

		const hookPromise = this.onWireHook(handle);
		hookPromise.catch(() => {}); // Suppress unhandled rejection

		try {
			const timeoutMs = timeout * 1000;
			const result = await Promise.race([
				handle.wait(),
				new Promise<HookResult>((_, reject) =>
					setTimeout(() => reject(new Error("timeout")), timeoutMs),
				),
			]);
			return result;
		} catch {
			logger.warn(`Wire hook timed out: ${event} ${target}`);
			return { action: "allow", reason: "", timedOut: true };
		}
	}
}
