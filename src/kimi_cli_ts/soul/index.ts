/**
 * Soul module — corresponds to Python soul/__init__.py
 *
 * Provides:
 * - Wire context via AsyncLocalStorage (replaces Python ContextVar)
 * - wireSend() for emitting wire messages from anywhere in the agent loop
 * - runSoul() wrapper that connects a Soul to a Wire + UI loop
 * - Soul protocol interface
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { Wire } from "../wire/wire_core.ts";
import type { WireMessage } from "../wire/types.ts";
import type { WireFile } from "../wire/file.ts";
import type {
	ContentPart,
	StatusSnapshot,
	ModelCapability,
	SlashCommand,
} from "../types.ts";
import type { HookEngine } from "../hooks/engine.ts";
import type { Runtime } from "./agent.ts";
import { QueueShutDown } from "../utils/queue.ts";
import { logger } from "../utils/logging.ts";

// ── Errors ─────────────────────────────────────────

export class LLMNotSet extends Error {
	constructor() {
		super("LLM is not set");
		this.name = "LLMNotSet";
	}
}

export class LLMNotSupported extends Error {
	readonly modelName: string;
	readonly capabilities: ModelCapability[];
	constructor(modelName: string, capabilities: ModelCapability[]) {
		const word = capabilities.length === 1 ? "capability" : "capabilities";
		super(
			`LLM model '${modelName}' does not support required ${word}: ${capabilities.join(", ")}`,
		);
		this.name = "LLMNotSupported";
		this.modelName = modelName;
		this.capabilities = capabilities;
	}
}

export class MaxStepsReached extends Error {
	readonly nSteps: number;
	constructor(nSteps: number) {
		super(`Max number of steps reached: ${nSteps}`);
		this.name = "MaxStepsReached";
		this.nSteps = nSteps;
	}
}

export class RunCancelled extends Error {
	constructor(message = "The run was cancelled") {
		super(message);
		this.name = "RunCancelled";
	}
}

// ── Status helpers ────────────────────────────────

export function formatTokenCount(n: number): string {
	if (n >= 1_000_000) {
		const value = n / 1_000_000;
		return `${Number(value.toFixed(1))}m`;
	}
	if (n >= 1_000) {
		const value = n / 1_000;
		return `${Number(value.toFixed(1))}k`;
	}
	return String(n);
}

export function formatContextStatus(
	contextUsage: number,
	contextTokens = 0,
	maxContextTokens = 0,
): string {
	const bounded = Math.max(0, Math.min(contextUsage, 1));
	if (maxContextTokens > 0) {
		const used = formatTokenCount(contextTokens);
		const total = formatTokenCount(maxContextTokens);
		return `context: ${(bounded * 100).toFixed(1)}% (${used}/${total})`;
	}
	return `context: ${(bounded * 100).toFixed(1)}%`;
}

// ── Soul protocol ─────────────────────────────────

export interface Soul {
	readonly name: string;
	readonly modelName: string;
	readonly modelCapabilities: Set<ModelCapability> | null;
	readonly thinking: boolean;
	readonly status: StatusSnapshot;
	readonly hookEngine: HookEngine;
	readonly availableSlashCommands: SlashCommand[];
	run(userInput: string | ContentPart[]): Promise<void>;
}

// ── UILoopFn ──────────────────────────────────────

/**
 * A long-running async function to visualize the agent behavior.
 * Reads from a Wire and updates the UI. Corresponds to Python's UILoopFn.
 */
export type UILoopFn = (wire: Wire) => Promise<void>;

// ── Wire context (AsyncLocalStorage) ──────────────

const _currentWire = new AsyncLocalStorage<Wire | null>();

/**
 * Get the current wire or null.
 * Expect to be not null when called from anywhere in the agent loop.
 */
export function getWireOrNull(): Wire | null {
	return _currentWire.getStore() ?? null;
}

/**
 * A wire message tagged with its type name for efficient serialization.
 * The __wireType field acts as a fast-path hint for serde, avoiding slow
 * trial-parsing in detectTypeName(). Compatible with WireMessage.
 */
export interface TaggedWireMessage extends Record<string, unknown> {
	readonly __wireType: string;
}

/**
 * Create a tagged wire message with explicit type name.
 * This is the primary way souls should construct wire messages.
 */
export function wireMsg(
	typeName: string,
	payload: Record<string, unknown> = {},
): TaggedWireMessage {
	return { __wireType: typeName, ...payload };
}

/**
 * Send a wire message to the current wire.
 * Take this as `print` and `input` for souls.
 * Souls should always use this function to send wire messages.
 */
export function wireSend(msg: TaggedWireMessage | WireMessage): void {
	const wire = getWireOrNull();
	if (!wire) {
		throw new Error("Wire is expected to be set when soul is running");
	}
	wire.soulSide.send(msg as WireMessage);
}

/**
 * Run a function with the given wire context.
 * Used by wire mode to attach a wire to soul operations.
 */
export async function runWithWireContext<T>(
	wire: Wire,
	fn: () => Promise<T>,
): Promise<T> {
	return _currentWire.run(wire, async () => {
		return fn();
	});
}

// ── runSoul ───────────────────────────────────────

/**
 * Run the soul with the given user input, connecting it to the UI loop with a Wire.
 *
 * `cancelController` is an outside handle that can be used to cancel the run.
 * When it is aborted, the run will be gracefully stopped and a RunCancelled
 * will be raised.
 *
 * Corresponds to Python run_soul() in soul/__init__.py:167-238.
 */
export async function runSoul(
	soul: Soul,
	userInput: string | ContentPart[],
	uiLoopFn: UILoopFn,
	cancelController: AbortController,
	opts?: {
		wireFile?: WireFile;
		runtime?: Runtime;
	},
): Promise<void> {
	const wire = new Wire({ fileBackend: opts?.wireFile });

	await _currentWire.run(wire, async () => {
		logger.debug("Starting UI loop");
		const uiTask = uiLoopFn(wire);

		logger.debug("Starting soul run");
		const soulTask = soul.run(userInput);
		const notificationTask = _pumpNotificationsToWire(
			opts?.runtime ?? null,
			wire,
		);

		// Create a cancellation promise
		const cancelPromise = new Promise<"cancelled">((resolve) => {
			if (cancelController.signal.aborted) {
				resolve("cancelled");
				return;
			}
			cancelController.signal.addEventListener(
				"abort",
				() => resolve("cancelled"),
				{
					once: true,
				},
			);
		});

		// Wait for either soul to complete or cancellation
		const result = await Promise.race([
			soulTask.then(() => "done" as const),
			cancelPromise,
		]);

		try {
			if (result === "cancelled") {
				logger.debug("Cancelling the run");
				// The soul should check the abort signal and stop
				// We need to wait for it to actually stop
				throw new RunCancelled();
			}
			// Soul task is done — check if it threw
			await soulTask;
		} finally {
			// Cancel notification pump
			notificationTask.cancel();

			// Flush any remaining notifications
			try {
				await _deliverNotificationsToWireOnce(opts?.runtime ?? null, wire);
			} catch (err) {
				logger.error(
					`Failed to flush notifications to wire during shutdown: ${err}`,
				);
			}

			logger.debug("Shutting down the UI loop");
			// Shutting down the wire should break the UI loop
			wire.shutdown();
			await wire.join();
			try {
				await Promise.race([
					uiTask,
					new Promise((resolve) => setTimeout(resolve, 500)),
				]);
			} catch (err) {
				if (err instanceof QueueShutDown) {
					logger.debug("UI loop shut down");
				} else {
					logger.warn(`UI loop error: ${err}`);
				}
			}
		}
	});
}

// ── Notification pump ─────────────────────────────

interface CancellableTask {
	cancel(): void;
}

function _pumpNotificationsToWire(
	runtime: Runtime | null,
	wire: Wire,
): CancellableTask {
	let cancelled = false;

	const run = async () => {
		while (!cancelled) {
			try {
				await _deliverNotificationsToWireOnce(runtime, wire);
			} catch (err) {
				if (!cancelled) {
					logger.error(`Notification wire pump failed: ${err}`);
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	};

	// Start in background — don't await
	run().catch(() => {});

	return {
		cancel() {
			cancelled = true;
		},
	};
}

async function _deliverNotificationsToWireOnce(
	runtime: Runtime | null,
	_wire: Wire,
): Promise<void> {
	if (!runtime || runtime.role !== "root") return;
	// TODO: Implement notification delivery when TS has notification system
	// Python calls runtime.notifications.deliver_pending() here
}
