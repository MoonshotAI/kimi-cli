/**
 * LLM-facing notification helpers — corresponds to Python notifications/llm.py
 *
 * Converts notification views into LLM-consumable messages and extracts
 * notification IDs from conversation history.
 */

import type { Message, ContentPart } from "../types.ts";
import type { NotificationView } from "./models.ts";

const NOTIFICATION_ID_RE = /<notification id="([^"]+)"/g;

/**
 * Build a user message from a notification view for injection into context.
 * Mirrors Python `build_notification_message`.
 *
 * The optional `runtime` parameter provides access to background task state
 * for enriching task notifications with output tails. When not provided,
 * task-specific details are omitted.
 */
export interface BackgroundTaskView {
	spec: { id: string; kind: string; description: string };
	runtime: { status: string; exitCode?: number | null; failureReason?: string };
}

export interface NotificationRuntime {
	backgroundTasks: {
		getTask(sourceId: string): BackgroundTaskView | undefined;
		tailOutput(
			taskId: string,
			opts: { maxBytes: number; maxLines: number },
		): string;
	};
	config: {
		background: {
			notificationTailChars: number;
			notificationTailLines: number;
		};
	};
}

export function buildNotificationMessage(
	view: NotificationView,
	runtime?: NotificationRuntime,
): Message {
	const event = view.event;
	const lines: string[] = [
		`<notification id="${event.id}" category="${event.category}" ` +
			`type="${event.type}" source_kind="${event.sourceKind}" source_id="${event.sourceId}">`,
		`Title: ${event.title}`,
		`Severity: ${event.severity}`,
		event.body,
	];

	if (
		runtime &&
		event.category === "task" &&
		event.sourceKind === "background_task"
	) {
		const taskView = runtime.backgroundTasks.getTask(event.sourceId);
		if (taskView) {
			const tail = runtime.backgroundTasks.tailOutput(taskView.spec.id, {
				maxBytes: runtime.config.background.notificationTailChars,
				maxLines: runtime.config.background.notificationTailLines,
			});
			lines.push(
				"<task-notification>",
				`Task ID: ${taskView.spec.id}`,
				`Task Type: ${taskView.spec.kind}`,
				`Description: ${taskView.spec.description}`,
				`Status: ${taskView.runtime.status}`,
			);
			if (taskView.runtime.exitCode != null) {
				lines.push(`Exit code: ${taskView.runtime.exitCode}`);
			}
			if (taskView.runtime.failureReason) {
				lines.push(`Failure reason: ${taskView.runtime.failureReason}`);
			}
			if (tail) {
				lines.push("Output tail:", tail);
			}
			lines.push("</task-notification>");
		}
	}

	lines.push("</notification>");
	const content: ContentPart[] = [{ type: "text", text: lines.join("\n") }];
	return { role: "user", content };
}

/**
 * Extract notification IDs from conversation history.
 * Scans user messages for `<notification id="...">` tags.
 */
export function extractNotificationIds(
	history: readonly Message[],
): Set<string> {
	const ids = new Set<string>();
	for (const message of history) {
		if (message.role !== "user") continue;
		const parts = Array.isArray(message.content) ? message.content : [];
		for (const part of parts) {
			if ("type" in part && part.type === "text" && "text" in part) {
				const text = part.text as string;
				// Reset regex lastIndex since we use the global flag
				NOTIFICATION_ID_RE.lastIndex = 0;
				let match: RegExpExecArray | null;
				while ((match = NOTIFICATION_ID_RE.exec(text)) !== null) {
					ids.add(match[1]!);
				}
			}
		}
	}
	return ids;
}

/**
 * Check whether a message is a notification injection message.
 */
export function isNotificationMessage(message: Message): boolean {
	if (message.role !== "user") return false;
	const parts = Array.isArray(message.content) ? message.content : [];
	if (parts.length !== 1) return false;
	const part = parts[0];
	return (
		part !== undefined &&
		"type" in part &&
		part.type === "text" &&
		"text" in part &&
		(part.text as string).trimStart().startsWith("<notification ")
	);
}
