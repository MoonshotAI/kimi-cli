/**
 * Wire core classes — corresponds to the Wire/WireSoulSide/WireUISide from Python wire/__init__.py
 * Separated to avoid circular imports with server.ts.
 */

import { AsyncQueue, BroadcastQueue, QueueShutDown } from "../utils/queue.ts";
import { WireFile } from "./file.ts";
import type { WireMessage } from "./types.ts";

type WireMessageQueue = BroadcastQueue<WireMessage>;

/**
 * MergeableMixin interface — messages implementing this can be merged in-place.
 */
export interface Mergeable {
	/** Try to merge another message into this one. Returns true if merged. */
	mergeInPlace(other: WireMessage): boolean;
}

export function isMergeable(msg: unknown): msg is Mergeable {
	return (
		msg != null &&
		typeof msg === "object" &&
		"mergeInPlace" in msg &&
		typeof (msg as Mergeable).mergeInPlace === "function"
	);
}

/**
 * A spmc channel for communication between the soul and the UI during a soul run.
 */
export class Wire {
	private _rawQueue: WireMessageQueue;
	private _mergedQueue: WireMessageQueue;
	private _soulSide: WireSoulSide;
	private _recorder: _WireRecorder | null;

	constructor(opts?: { fileBackend?: WireFile }) {
		this._rawQueue = new BroadcastQueue<WireMessage>();
		this._mergedQueue = new BroadcastQueue<WireMessage>();
		this._soulSide = new WireSoulSide(this._rawQueue, this._mergedQueue);

		if (opts?.fileBackend) {
			this._recorder = new _WireRecorder(
				opts.fileBackend,
				this._mergedQueue.subscribe(),
			);
		} else {
			this._recorder = null;
		}
	}

	get soulSide(): WireSoulSide {
		return this._soulSide;
	}

	/**
	 * Create a UI side of the Wire.
	 * @param merge Whether to merge Wire messages as much as possible.
	 */
	uiSide(merge: boolean): WireUISide {
		if (merge) {
			return new WireUISide(this._mergedQueue.subscribe());
		} else {
			return new WireUISide(this._rawQueue.subscribe());
		}
	}

	shutdown(): void {
		this._soulSide.flush();
		this._rawQueue.shutdown();
		this._mergedQueue.shutdown();
	}

	async join(): Promise<void> {
		if (this._recorder === null) return;
		try {
			await this._recorder.join();
		} catch (err) {
			console.error("Wire recorder failed to flush:", err);
		}
	}
}

/**
 * The soul side of a Wire.
 */
export class WireSoulSide {
	private _rawQueue: WireMessageQueue;
	private _mergedQueue: WireMessageQueue;
	private _mergeBuffer: (WireMessage & Mergeable) | null = null;

	constructor(rawQueue: WireMessageQueue, mergedQueue: WireMessageQueue) {
		this._rawQueue = rawQueue;
		this._mergedQueue = mergedQueue;
	}

	send(msg: WireMessage): void {
		// Send raw message
		try {
			this._rawQueue.publishNowait(msg);
		} catch (e) {
			if (e instanceof QueueShutDown) {
				// Queue shut down, drop the message
			} else {
				throw e;
			}
		}

		// Merge and send merged message
		if (isMergeable(msg)) {
			if (this._mergeBuffer === null) {
				this._mergeBuffer = structuredClone(msg) as WireMessage & Mergeable;
			} else if (this._mergeBuffer.mergeInPlace(msg)) {
				// Successfully merged
			} else {
				this.flush();
				this._mergeBuffer = structuredClone(msg) as WireMessage & Mergeable;
			}
		} else {
			this.flush();
			this._sendMerged(msg);
		}
	}

	flush(): void {
		const buffer = this._mergeBuffer;
		if (buffer === null) return;
		this._sendMerged(buffer as WireMessage);
		this._mergeBuffer = null;
	}

	private _sendMerged(msg: WireMessage): void {
		try {
			this._mergedQueue.publishNowait(msg);
		} catch (e) {
			if (e instanceof QueueShutDown) {
				// Queue shut down, drop the message
			} else {
				throw e;
			}
		}
	}
}

/**
 * The UI side of a Wire.
 */
export class WireUISide {
	private _queue: AsyncQueue<WireMessage>;

	constructor(queue: AsyncQueue<WireMessage>) {
		this._queue = queue;
	}

	async receive(): Promise<WireMessage> {
		return await this._queue.get();
	}
}

/**
 * Async consumer that records Wire messages to a WireFile.
 */
class _WireRecorder {
	private _wireFile: WireFile;
	private _running: Promise<void>;

	constructor(wireFile: WireFile, queue: AsyncQueue<WireMessage>) {
		this._wireFile = wireFile;
		this._running = this._consumeLoop(queue);
	}

	async join(): Promise<void> {
		await this._running;
	}

	private async _consumeLoop(queue: AsyncQueue<WireMessage>): Promise<void> {
		while (true) {
			try {
				const msg = await queue.get();
				await this._record(msg);
			} catch (e) {
				if (e instanceof QueueShutDown) {
					break;
				}
				throw e;
			}
		}
	}

	private async _record(msg: WireMessage): Promise<void> {
		await this._wireFile.appendMessage(msg as Record<string, unknown>);
	}
}
