/**
 * Async queue with shutdown support — corresponds to Python's utils/aioqueue.py
 * and utils/broadcast.py
 */

// ── QueueShutDown ──────────────────────────────────────────

export class QueueShutDown extends Error {
	constructor() {
		super("Queue has been shut down");
		this.name = "QueueShutDown";
	}
}

// ── AsyncQueue ─────────────────────────────────────────────

/**
 * Unbounded async queue with shutdown support.
 * Modeled after Python's asyncio.Queue.
 */
export class AsyncQueue<T> {
	private _buffer: T[] = [];
	private _waiters: Array<{
		resolve: (value: T) => void;
		reject: (err: Error) => void;
	}> = [];
	private _shutdown = false;

	get closed(): boolean {
		return this._shutdown;
	}

	put(item: T): void {
		if (this._shutdown) throw new QueueShutDown();
		if (this._waiters.length > 0) {
			const waiter = this._waiters.shift()!;
			waiter.resolve(item);
		} else {
			this._buffer.push(item);
		}
	}

	async get(): Promise<T> {
		if (this._buffer.length > 0) {
			return this._buffer.shift()!;
		}
		if (this._shutdown) throw new QueueShutDown();
		return new Promise<T>((resolve, reject) => {
			this._waiters.push({ resolve, reject });
		});
	}

	shutdown(immediate = false): void {
		if (this._shutdown) return;
		this._shutdown = true;
		if (immediate) {
			this._buffer.length = 0;
		}
		// Wake all waiters with QueueShutDown
		for (const waiter of this._waiters) {
			waiter.reject(new QueueShutDown());
		}
		this._waiters.length = 0;
	}

	get empty(): boolean {
		return this._buffer.length === 0;
	}
}

// ── BroadcastQueue ─────────────────────────────────────────

/**
 * A broadcast queue that allows multiple subscribers to receive published items.
 */
export class BroadcastQueue<T> {
	private _queues = new Set<AsyncQueue<T>>();

	subscribe(): AsyncQueue<T> {
		const queue = new AsyncQueue<T>();
		this._queues.add(queue);
		return queue;
	}

	unsubscribe(queue: AsyncQueue<T>): void {
		this._queues.delete(queue);
	}

	publishNowait(item: T): void {
		for (const queue of this._queues) {
			queue.put(item);
		}
	}

	shutdown(immediate = false): void {
		for (const queue of this._queues) {
			queue.shutdown(immediate);
		}
		this._queues.clear();
	}
}
