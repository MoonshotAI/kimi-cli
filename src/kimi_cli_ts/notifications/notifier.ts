/**
 * Notification watcher — corresponds to Python notifications/notifier.py
 * Polls the manager for pending notifications on a given sink.
 */

import { logger } from "../utils/logging.ts";
import type { NotificationManager } from "./manager.ts";
import type { NotificationSink, NotificationView } from "./models.ts";

export class NotificationWatcher {
	private _manager: NotificationManager;
	private _sink: NotificationSink;
	private _onNotification: (view: NotificationView) => Promise<void> | void;
	private _beforePoll?: () => void;
	private _intervalS: number;

	constructor(opts: {
		manager: NotificationManager;
		sink: NotificationSink;
		onNotification: (view: NotificationView) => Promise<void> | void;
		beforePoll?: () => void;
		intervalS?: number;
	}) {
		this._manager = opts.manager;
		this._sink = opts.sink;
		this._onNotification = opts.onNotification;
		this._beforePoll = opts.beforePoll;
		this._intervalS = opts.intervalS ?? 1.0;
	}

	async pollOnce(): Promise<NotificationView[]> {
		return this._manager.deliverPending(this._sink, {
			onNotification: this._onNotification,
			beforeClaim: this._beforePoll,
		});
	}

	async runForever(signal?: AbortSignal): Promise<void> {
		while (!signal?.aborted) {
			try {
				await this.pollOnce();
			} catch (err) {
				if (signal?.aborted) break;
				logger.error("NotificationWatcher poll failed");
			}
			await Bun.sleep(this._intervalS * 1000);
		}
	}
}
