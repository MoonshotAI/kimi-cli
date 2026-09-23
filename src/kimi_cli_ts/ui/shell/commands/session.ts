/**
 * Session-related slash commands: /new, /sessions, /title
 */

import {
	Session,
	loadSessionState,
	saveSessionState,
} from "../../../session.ts";
import type { CommandPanelConfig } from "../../../types.ts";
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getShareDir } from "../../../config.ts";

type Notify = (title: string, body: string) => void;
type TriggerReload = (sessionId: string, prefillText?: string) => void;

function getSessionsDirSync(workDir: string): string {
	const pathMd5 = createHash("md5").update(workDir, "utf-8").digest("hex");
	return join(getShareDir(), "sessions", pathMd5);
}

function formatRelativeTimeMs(timestampMs: number): string {
	if (!timestampMs) return "unknown";
	const diff = (Date.now() - timestampMs) / 1000;
	if (diff < 60) return "just now";
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	return `${Math.floor(diff / 86400)}d ago`;
}

export function createSessionsPanel(
	session: Session,
	notify: Notify,
	triggerReload: TriggerReload,
): CommandPanelConfig | null {
	const sessionsDir = getSessionsDirSync(session.workDir);
	if (!existsSync(sessionsDir)) return null;

	let entries: string[];
	try {
		entries = readdirSync(sessionsDir);
	} catch {
		return null;
	}

	interface SessionInfo {
		id: string;
		title: string;
		updatedAt: number;
	}

	const sessions: SessionInfo[] = [];
	for (const entry of entries) {
		const sessionDir = join(sessionsDir, entry);
		const contextFile = join(sessionDir, "context.jsonl");
		if (!existsSync(contextFile)) continue;

		let title = "Untitled";
		let updatedAt = 0;
		try {
			const stat = statSync(contextFile);
			updatedAt = stat.mtimeMs;
		} catch {
			/* ignore */
		}

		// Try state file for custom_title
		const stateFile = join(sessionDir, "state.json");
		let hasCustomTitle = false;
		if (existsSync(stateFile)) {
			try {
				const stateData = JSON.parse(readFileSync(stateFile, "utf-8"));
				if (stateData.custom_title) {
					title = stateData.custom_title;
					hasCustomTitle = true;
				}
			} catch {
				/* ignore */
			}
		}

		// If no custom title, try wire file for first user input
		if (title === "Untitled") {
			const wireFile = join(sessionDir, "wire.jsonl");
			if (existsSync(wireFile)) {
				try {
					const text = readFileSync(wireFile, "utf-8");
					for (const line of text.split("\n")) {
						const trimmed = line.trim();
						if (!trimmed) continue;
						try {
							const record = JSON.parse(trimmed);
							if (record.type === "turn_begin" && record.user_input) {
								const raw =
									typeof record.user_input === "string"
										? record.user_input
										: JSON.stringify(record.user_input);
								title = raw.slice(0, 50);
								break;
							}
						} catch {
							continue;
						}
					}
				} catch {
					/* ignore */
				}
			}
		}

		// Skip empty sessions (session with no custom title and no wire events)
		if (title === "Untitled" && !hasCustomTitle) continue;

		sessions.push({ id: entry, title, updatedAt });
	}

	sessions.sort((a, b) => b.updatedAt - a.updatedAt);

	if (sessions.length === 0) return null;

	const items = sessions.map((s) => ({
		label: s.title,
		value: s.id,
		description: formatRelativeTimeMs(s.updatedAt),
		current: s.id === session.id,
	}));

	return {
		type: "choice",
		title: "Switch Session",
		items,
		onSelect: (value: string) => {
			if (value === session.id) {
				notify("Sessions", "Already in this session.");
				return;
			}
			triggerReload(value);
			notify("Sessions", `Switching to session: ${value}`);
		},
	};
}

export async function handleNew(session: Session): Promise<string> {
	const workDir = session.workDir;
	if (await session.isEmpty()) {
		await session.delete();
	}
	const newSession = await Session.create(workDir);
	return `New session created: ${newSession.id}. Please restart to switch.`;
}

export async function handleSessions(session: Session): Promise<string> {
	const sessions = await Session.list(session.workDir);
	if (sessions.length === 0) {
		return "No sessions found.";
	}
	const lines: string[] = [];
	for (const s of sessions) {
		const current = s.id === session.id ? " (current)" : "";
		const timeAgo = formatRelativeTime(s.updatedAt);
		lines.push(`  ${s.title}, ${timeAgo}${current}`);
	}
	return lines.join("\n");
}

export async function handleTitle(
	session: Session,
	args: string,
): Promise<string> {
	if (!args.trim()) {
		return `Session title: ${session.title}`;
	}
	const newTitle = args.trim().slice(0, 200);
	const freshState = await loadSessionState(session.dir);
	freshState.custom_title = newTitle;
	freshState.title_generated = true;
	await saveSessionState(freshState, session.dir);
	session.state.custom_title = newTitle;
	session.title = newTitle;
	return `Session title set to: ${newTitle}`;
}

export function createTitlePanel(
	session: Session,
	notify: Notify,
): CommandPanelConfig {
	const currentTitle = session.title || "Untitled";
	return {
		type: "input",
		title: `Session Title — ${currentTitle}`,
		placeholder: "Enter a new title...",
		onSubmit: (value: string) => {
			const newTitle = value.trim().slice(0, 200);
			if (!newTitle) return;
			loadSessionState(session.dir).then((state) => {
				state.custom_title = newTitle;
				state.title_generated = true;
				saveSessionState(state, session.dir).then(() => {
					session.state.custom_title = newTitle;
					session.title = newTitle;
					notify("Title", `Session title set to: ${newTitle}`);
				});
			});
		},
	};
}

function formatRelativeTime(timestamp: number): string {
	if (!timestamp) return "unknown";
	const now = Date.now() / 1000;
	const diff = now - timestamp;
	if (diff < 60) return "just now";
	if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
	return `${Math.floor(diff / 86400)} days ago`;
}
