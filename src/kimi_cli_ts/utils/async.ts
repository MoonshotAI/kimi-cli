/**
 * Async utilities — corresponds to Python utils/async patterns
 */

/** Sleep for given milliseconds. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run a function with a timeout. Rejects with TimeoutError if exceeded. */
export async function withTimeout<T>(
	fn: () => Promise<T>,
	timeoutMs: number,
): Promise<T> {
	return Promise.race([
		fn(),
		new Promise<never>((_, reject) =>
			setTimeout(
				() => reject(new TimeoutError(`Timed out after ${timeoutMs}ms`)),
				timeoutMs,
			),
		),
	]);
}

export class TimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TimeoutError";
	}
}

/**
 * Deferred — a promise that can be resolved/rejected externally.
 * Similar to Python's asyncio.Future.
 */
export class Deferred<T> {
	readonly promise: Promise<T>;
	resolve!: (value: T) => void;
	reject!: (reason: unknown) => void;
	private _settled = false;

	constructor() {
		this.promise = new Promise<T>((resolve, reject) => {
			this.resolve = (v: T) => {
				if (!this._settled) {
					this._settled = true;
					resolve(v);
				}
			};
			this.reject = (r: unknown) => {
				if (!this._settled) {
					this._settled = true;
					reject(r);
				}
			};
		});
	}

	get settled(): boolean {
		return this._settled;
	}
}

/** Run tasks with a concurrency limit. */
export async function mapConcurrent<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let index = 0;

	async function worker() {
		while (index < items.length) {
			const i = index++;
			results[i] = await fn(items[i]!);
		}
	}

	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) },
		() => worker(),
	);
	await Promise.all(workers);
	return results;
}
