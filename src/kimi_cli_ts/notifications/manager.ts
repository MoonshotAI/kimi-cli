/**
 * Notification manager — corresponds to Python notifications/manager.py
 * Publishes notifications with deduplication and claim/ack delivery flow.
 */

import { randomUUID } from "node:crypto";
import { logger } from "../utils/logging.ts";
import type {
	NotificationEvent,
	NotificationDelivery,
	NotificationSinkState,
	NotificationView,
} from "./models.ts";
import { NotificationStore } from "./store.ts";

export interface NotificationConfig {
	claimStaleAfterMs: number;
}

export class NotificationManager {
	private _config: NotificationConfig;
	private _store: NotificationStore;

	constructor(root: string, config?: Partial<NotificationConfig>) {
		this._config = { claimStaleAfterMs: config?.claimStaleAfterMs ?? 15_000 };
		this._store = new NotificationStore(root);
	}

	get store(): NotificationStore {
		return this._store;
	}

	newId(): string {
		return `n${randomUUID().replace(/-/g, "").slice(0, 8)}`;
	}

	private initialDelivery(event: NotificationEvent): NotificationDelivery {
		const sinks: Record<string, NotificationSinkState> = {};
		for (const sink of event.targets) {
			sinks[sink] = { status: "pending" };
		}
		return { sinks };
	}

	findByDedupeKey(dedupeKey: string): NotificationView | undefined {
		for (const view of this._store.listViews()) {
			if (view.event.dedupeKey === dedupeKey) {
				return view;
			}
		}
		return undefined;
	}

	publish(event: NotificationEvent): NotificationView {
		if (event.dedupeKey) {
			const existing = this.findByDedupeKey(event.dedupeKey);
			if (existing) return existing;
		}
		const delivery = this.initialDelivery(event);
		this._store.createNotification(event, delivery);
		return { event, delivery };
	}

	recover(): void {
		const now = Date.now() / 1000;
		const staleAfter = this._config.claimStaleAfterMs / 1000;
		for (const view of this._store.listViews()) {
			let updated = false;
			const delivery = structuredClone(view.delivery);
			for (const sinkState of Object.values(delivery.sinks)) {
				if (sinkState.status !== "claimed" || sinkState.claimedAt == null)
					continue;
				if (now - sinkState.claimedAt <= staleAfter) continue;
				sinkState.status = "pending";
				sinkState.claimedAt = undefined;
				updated = true;
			}
			if (updated) {
				this._store.writeDelivery(view.event.id, delivery);
			}
		}
	}

	hasPendingForSink(sink: string): boolean {
		for (const view of this._store.listViews()) {
			const sinkState = view.delivery.sinks[sink];
			if (sinkState && sinkState.status === "pending") return true;
		}
		return false;
	}

	claimForSink(sink: string, limit = 8): NotificationView[] {
		this.recover();
		const claimed: NotificationView[] = [];
		const now = Date.now() / 1000;
		const views = this._store.listViews();
		// Process in reverse (oldest first)
		for (let i = views.length - 1; i >= 0; i--) {
			const view = views[i]!;
			const sinkState = view.delivery.sinks[sink];
			if (
				!sinkState ||
				sinkState.status === "acked" ||
				sinkState.status === "claimed"
			)
				continue;
			const delivery = structuredClone(view.delivery);
			const targetState = delivery.sinks[sink]!;
			targetState.status = "claimed";
			targetState.claimedAt = now;
			this._store.writeDelivery(view.event.id, delivery);
			claimed.push({ event: view.event, delivery });
			if (claimed.length >= limit) break;
		}
		return claimed;
	}

	async deliverPending(
		sink: string,
		opts: {
			onNotification: (view: NotificationView) => Promise<void> | void;
			limit?: number;
			beforeClaim?: () => void;
		},
	): Promise<NotificationView[]> {
		if (opts.beforeClaim) opts.beforeClaim();
		const delivered: NotificationView[] = [];
		for (const view of this.claimForSink(sink, opts.limit ?? 8)) {
			try {
				const result = opts.onNotification(view);
				if (result instanceof Promise) await result;
			} catch {
				logger.warn(
					`Notification handler failed for ${sink}/${view.event.id}, leaving claimed`,
				);
				continue;
			}
			delivered.push(this.ack(sink, view.event.id));
		}
		return delivered;
	}

	ack(sink: string, notificationId: string): NotificationView {
		const view = this._store.mergedView(notificationId);
		const delivery = structuredClone(view.delivery);
		const sinkState = delivery.sinks[sink];
		if (!sinkState) return view;
		sinkState.status = "acked";
		sinkState.ackedAt = Date.now() / 1000;
		sinkState.claimedAt = undefined;
		this._store.writeDelivery(notificationId, delivery);
		return { event: view.event, delivery };
	}

	ackIds(sink: string, notificationIds: Set<string>): void {
		for (const id of notificationIds) {
			try {
				this.ack(sink, id);
			} catch {
				// ignore missing
			}
		}
	}
}
