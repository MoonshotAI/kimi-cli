/**
 * Notification store — corresponds to Python notifications/store.py
 * File-based persistence for notification events and delivery state.
 */

import { join } from "node:path";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	readdirSync,
	statSync,
} from "node:fs";
import { logger } from "../utils/logging.ts";
import {
	type NotificationEvent,
	type NotificationDelivery,
	type NotificationView,
	type NotificationSinkState,
	eventToJson,
	eventFromJson,
	deliveryToJson,
	deliveryFromJson,
} from "./models.ts";

const VALID_NOTIFICATION_ID = /^[a-z0-9]{2,20}$/;

function validateNotificationId(id: string): void {
	if (!VALID_NOTIFICATION_ID.test(id)) {
		throw new Error(`Invalid notification_id: ${id}`);
	}
}

function atomicJsonWrite(
	data: Record<string, unknown>,
	filePath: string,
): void {
	const tmpPath = filePath + ".tmp";
	writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
	const { renameSync } = require("node:fs");
	renameSync(tmpPath, filePath);
}

export class NotificationStore {
	static readonly EVENT_FILE = "event.json";
	static readonly DELIVERY_FILE = "delivery.json";

	private _root: string;

	constructor(root: string) {
		this._root = root;
	}

	get root(): string {
		return this._root;
	}

	private ensureRoot(): string {
		if (!existsSync(this._root)) {
			mkdirSync(this._root, { recursive: true });
		}
		return this._root;
	}

	notificationDir(notificationId: string): string {
		validateNotificationId(notificationId);
		const path = join(this.ensureRoot(), notificationId);
		if (!existsSync(path)) {
			mkdirSync(path, { recursive: true });
		}
		return path;
	}

	notificationPath(notificationId: string): string {
		validateNotificationId(notificationId);
		return join(this._root, notificationId);
	}

	eventPath(notificationId: string): string {
		return join(
			this.notificationPath(notificationId),
			NotificationStore.EVENT_FILE,
		);
	}

	deliveryPath(notificationId: string): string {
		return join(
			this.notificationPath(notificationId),
			NotificationStore.DELIVERY_FILE,
		);
	}

	createNotification(
		event: NotificationEvent,
		delivery: NotificationDelivery,
	): void {
		const dir = this.notificationDir(event.id);
		atomicJsonWrite(
			eventToJson(event),
			join(dir, NotificationStore.EVENT_FILE),
		);
		atomicJsonWrite(
			deliveryToJson(delivery),
			join(dir, NotificationStore.DELIVERY_FILE),
		);
	}

	listNotificationIds(): string[] {
		if (!existsSync(this._root)) return [];
		const ids: string[] = [];
		for (const entry of readdirSync(this._root).sort()) {
			const dirPath = join(this._root, entry);
			try {
				if (!statSync(dirPath).isDirectory()) continue;
			} catch {
				continue;
			}
			if (!existsSync(join(dirPath, NotificationStore.EVENT_FILE))) continue;
			ids.push(entry);
		}
		return ids;
	}

	readEvent(notificationId: string): NotificationEvent {
		const data = JSON.parse(
			readFileSync(this.eventPath(notificationId), "utf-8"),
		);
		return eventFromJson(data);
	}

	writeEvent(event: NotificationEvent): void {
		atomicJsonWrite(eventToJson(event), this.eventPath(event.id));
	}

	readDelivery(notificationId: string): NotificationDelivery {
		const path = this.deliveryPath(notificationId);
		if (!existsSync(path)) return { sinks: {} };
		try {
			const data = JSON.parse(readFileSync(path, "utf-8"));
			return deliveryFromJson(data);
		} catch (err) {
			logger.warn(
				`Corrupted delivery file for notification ${notificationId}, using default: ${err}`,
			);
			return { sinks: {} };
		}
	}

	writeDelivery(notificationId: string, delivery: NotificationDelivery): void {
		atomicJsonWrite(
			deliveryToJson(delivery),
			this.deliveryPath(notificationId),
		);
	}

	mergedView(notificationId: string): NotificationView {
		return {
			event: this.readEvent(notificationId),
			delivery: this.readDelivery(notificationId),
		};
	}

	listViews(): NotificationView[] {
		const views: NotificationView[] = [];
		for (const id of this.listNotificationIds()) {
			try {
				views.push(this.mergedView(id));
			} catch (err) {
				logger.warn(`Skipping corrupted notification ${id}: ${err}`);
			}
		}
		views.sort((a, b) => b.event.createdAt - a.event.createdAt);
		return views;
	}
}
