/**
 * Root Wire Hub — session-level broadcast hub for out-of-turn wire messages.
 * Corresponds to Python's wire/root_hub.py
 *
 * Allows multiple consumers (e.g., WireServer, Shell UI) to receive
 * events published from background tasks, approval runtime, etc.
 */

import { AsyncQueue, BroadcastQueue } from "../utils/queue.ts";
import type { WireMessage } from "./types.ts";

export class RootWireHub {
	private _queue = new BroadcastQueue<WireMessage>();

	/** Create a new subscriber queue. */
	subscribe(): AsyncQueue<WireMessage> {
		return this._queue.subscribe();
	}

	/** Remove a subscriber queue. */
	unsubscribe(queue: AsyncQueue<WireMessage>): void {
		this._queue.unsubscribe(queue);
	}

	/** Publish a message to all subscribers (async, for await compatibility). */
	async publish(msg: WireMessage): Promise<void> {
		this._queue.publishNowait(msg);
	}

	/** Publish a message synchronously. */
	publishNowait(msg: WireMessage): void {
		this._queue.publishNowait(msg);
	}

	/** Shut down the hub and all subscriber queues. */
	shutdown(): void {
		this._queue.shutdown();
	}
}
