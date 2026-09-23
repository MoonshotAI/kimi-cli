/**
 * Wire notification bridge — corresponds to Python notifications/wire.py
 * Converts NotificationView to wire protocol Notification.
 */

import type { NotificationView } from "./models.ts";

export interface WireNotification {
	id: string;
	category: string;
	type: string;
	source_kind: string;
	source_id: string;
	title: string;
	body: string;
	severity: string;
	created_at: number;
	payload: Record<string, unknown>;
}

export function toWireNotification(view: NotificationView): WireNotification {
	const e = view.event;
	return {
		id: e.id,
		category: e.category,
		type: e.type,
		source_kind: e.sourceKind,
		source_id: e.sourceId,
		title: e.title,
		body: e.body,
		severity: e.severity,
		created_at: e.createdAt,
		payload: e.payload,
	};
}
