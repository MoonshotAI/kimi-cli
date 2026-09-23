/**
 * Notification models — corresponds to Python notifications/models.py
 */

export type NotificationCategory = "task" | "agent" | "system";
export type NotificationSeverity = "info" | "success" | "warning" | "error";
export type NotificationSink = "llm" | "wire" | "shell";
export type NotificationDeliveryStatus = "pending" | "claimed" | "acked";

export interface NotificationEvent {
	version: number;
	id: string;
	category: NotificationCategory;
	type: string;
	sourceKind: string;
	sourceId: string;
	title: string;
	body: string;
	severity: NotificationSeverity;
	createdAt: number;
	payload: Record<string, unknown>;
	targets: NotificationSink[];
	dedupeKey?: string;
}

export interface NotificationSinkState {
	status: NotificationDeliveryStatus;
	claimedAt?: number;
	ackedAt?: number;
}

export interface NotificationDelivery {
	sinks: Record<string, NotificationSinkState>;
}

export interface NotificationView {
	event: NotificationEvent;
	delivery: NotificationDelivery;
}

// ── JSON serialization helpers (snake_case ↔ camelCase) ──

export function eventToJson(e: NotificationEvent): Record<string, unknown> {
	return {
		version: e.version,
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
		targets: e.targets,
		dedupe_key: e.dedupeKey,
	};
}

export function eventFromJson(
	data: Record<string, unknown>,
): NotificationEvent {
	return {
		version: Number(data.version ?? 1),
		id: String(data.id),
		category: String(data.category ?? "system") as NotificationCategory,
		type: String(data.type ?? ""),
		sourceKind: String(data.source_kind ?? data.sourceKind ?? ""),
		sourceId: String(data.source_id ?? data.sourceId ?? ""),
		title: String(data.title ?? ""),
		body: String(data.body ?? ""),
		severity: String(data.severity ?? "info") as NotificationSeverity,
		createdAt: Number(data.created_at ?? data.createdAt ?? Date.now() / 1000),
		payload: (data.payload as Record<string, unknown>) ?? {},
		targets: (data.targets as NotificationSink[]) ?? ["llm", "wire", "shell"],
		dedupeKey: (data.dedupe_key ?? data.dedupeKey) as string | undefined,
	};
}

export function deliveryToJson(
	d: NotificationDelivery,
): Record<string, unknown> {
	const sinks: Record<string, unknown> = {};
	for (const [key, state] of Object.entries(d.sinks)) {
		sinks[key] = {
			status: state.status,
			claimed_at: state.claimedAt,
			acked_at: state.ackedAt,
		};
	}
	return { sinks };
}

export function deliveryFromJson(
	data: Record<string, unknown>,
): NotificationDelivery {
	const rawSinks =
		(data.sinks as Record<string, Record<string, unknown>>) ?? {};
	const sinks: Record<string, NotificationSinkState> = {};
	for (const [key, raw] of Object.entries(rawSinks)) {
		sinks[key] = {
			status: String(raw.status ?? "pending") as NotificationDeliveryStatus,
			claimedAt: raw.claimed_at != null ? Number(raw.claimed_at) : undefined,
			ackedAt: raw.acked_at != null ? Number(raw.acked_at) : undefined,
		};
	}
	return { sinks };
}

export function newNotificationEvent(opts: {
	id: string;
	category: NotificationCategory;
	type: string;
	sourceKind: string;
	sourceId: string;
	title: string;
	body: string;
	severity?: NotificationSeverity;
	payload?: Record<string, unknown>;
	targets?: NotificationSink[];
	dedupeKey?: string;
}): NotificationEvent {
	return {
		version: 1,
		id: opts.id,
		category: opts.category,
		type: opts.type,
		sourceKind: opts.sourceKind,
		sourceId: opts.sourceId,
		title: opts.title,
		body: opts.body,
		severity: opts.severity ?? "info",
		createdAt: Date.now() / 1000,
		payload: opts.payload ?? {},
		targets: opts.targets ?? ["llm", "wire", "shell"],
		dedupeKey: opts.dedupeKey,
	};
}
