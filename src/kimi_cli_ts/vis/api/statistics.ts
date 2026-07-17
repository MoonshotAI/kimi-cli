/**
 * Vis API for aggregate statistics across all sessions.
 * Corresponds to Python vis/api/statistics.py
 */

import { join } from "node:path";
import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { getShareDir } from "../../share.ts";
import { collectEvents } from "./sessions.ts";
import {
	parseWireFileLine,
	type WireFileMetadata,
	type WireMessageRecord,
} from "../../wire/file.ts";
import { loadMetadata } from "../../metadata.ts";
import { createHash } from "node:crypto";

// ── Cache ─────────────────────────────────────────────────

let _cache: { result: Record<string, any>; timestamp: number } | null = null;
const CACHE_TTL = 60; // seconds

// ── Helper ────────────────────────────────────────────────

function isWireFileMetadata(
	parsed: WireFileMetadata | WireMessageRecord,
): parsed is WireFileMetadata {
	return "type" in parsed && (parsed as any).type === "metadata";
}

async function getWorkDirForHash(hashDirName: string): Promise<string | null> {
	try {
		const metadata = await loadMetadata();
		for (const wd of metadata.workDirs) {
			const pathMd5 = createHash("md5").update(wd.path, "utf-8").digest("hex");
			const dirBasename =
				wd.kaos === "local" ? pathMd5 : `${wd.kaos}_${pathMd5}`;
			if (dirBasename === hashDirName) return wd.path;
		}
	} catch {
		// Ignore
	}
	return null;
}

// ── Route handler ─────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Access-Control-Allow-Origin": "*",
		},
	});
}

export async function handleStatisticsRoute(): Promise<Response> {
	const now = Date.now() / 1000;
	if (_cache && now - _cache.timestamp < CACHE_TTL) {
		return jsonResponse(_cache.result);
	}

	const sessionsRoot = join(getShareDir(), "sessions");
	if (!existsSync(sessionsRoot)) {
		const empty = {
			total_sessions: 0,
			total_turns: 0,
			total_tokens: { input: 0, output: 0 },
			total_duration_sec: 0,
			tool_usage: [],
			daily_usage: [],
			per_project: [],
		};
		_cache = { result: empty, timestamp: now };
		return jsonResponse(empty);
	}

	let totalSessions = 0;
	let totalTurns = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalDurationSec = 0;

	// tool_name -> { count, error_count }
	const toolStats = new Map<string, { count: number; error_count: number }>();

	// date_str -> { sessions, turns }
	const dailyStats = new Map<string, { sessions: number; turns: number }>();

	// work_dir -> { sessions, turns }
	const projectStats = new Map<string, { sessions: number; turns: number }>();

	for (const workDirHashName of readdirSync(sessionsRoot)) {
		const workDirHashDir = join(sessionsRoot, workDirHashName);
		if (!statSync(workDirHashDir).isDirectory()) continue;

		const workDir =
			(await getWorkDirForHash(workDirHashName)) ?? workDirHashName;

		for (const sessionName of readdirSync(workDirHashDir)) {
			const sessionDir = join(workDirHashDir, sessionName);
			if (!statSync(sessionDir).isDirectory()) continue;

			const wirePath = join(sessionDir, "wire.jsonl");
			if (!existsSync(wirePath)) continue;

			totalSessions++;
			let sessionTurns = 0;
			let sessionInputTokens = 0;
			let sessionOutputTokens = 0;
			let firstTs = 0;
			let lastTs = 0;
			let sessionDate: string | null = null;

			const pendingTools = new Map<string, string>();

			try {
				const content = readFileSync(wirePath, "utf-8");
				for (const rawLine of content.split("\n")) {
					const line = rawLine.trim();
					if (!line) continue;

					let parsed: WireFileMetadata | WireMessageRecord;
					try {
						parsed = parseWireFileLine(line);
					} catch {
						continue;
					}
					if (isWireFileMetadata(parsed)) continue;

					const record = parsed as WireMessageRecord;
					const ts = record.timestamp;
					const msgType = record.message.type;
					const payload = record.message.payload ?? {};

					if (firstTs === 0) {
						firstTs = ts;
						try {
							const dt = new Date(ts * 1000);
							sessionDate = dt.toISOString().slice(0, 10);
						} catch {
							// Ignore
						}
					}
					lastTs = ts;

					const eventsToProcess: Array<{
						type: string;
						payload: Record<string, any>;
					}> = [];
					collectEvents(msgType, payload, eventsToProcess);

					for (const ev of eventsToProcess) {
						switch (ev.type) {
							case "TurnBegin":
								sessionTurns++;
								break;
							case "ToolCall": {
								const fn = ev.payload.function;
								const toolId = ev.payload.id ?? "";
								if (fn && typeof fn === "object") {
									const name = fn.name ?? "unknown";
									const stats = toolStats.get(name) ?? {
										count: 0,
										error_count: 0,
									};
									stats.count++;
									toolStats.set(name, stats);
									if (toolId) pendingTools.set(toolId, name);
								}
								break;
							}
							case "ToolResult": {
								const toolCallId = ev.payload.tool_call_id ?? "";
								const rv = ev.payload.return_value;
								if (rv && typeof rv === "object" && rv.is_error) {
									const toolName = pendingTools.get(toolCallId);
									if (toolName) {
										const stats = toolStats.get(toolName);
										if (stats) stats.error_count++;
									}
								}
								pendingTools.delete(toolCallId);
								break;
							}
							case "StatusUpdate": {
								const tu = ev.payload.token_usage;
								if (tu && typeof tu === "object") {
									sessionInputTokens +=
										(Number(tu.input_other) || 0) +
										(Number(tu.input_cache_read) || 0) +
										(Number(tu.input_cache_creation) || 0);
									sessionOutputTokens += Number(tu.output) || 0;
								}
								break;
							}
						}
					}
				}
			} catch {
				continue;
			}

			totalTurns += sessionTurns;
			totalInputTokens += sessionInputTokens;
			totalOutputTokens += sessionOutputTokens;

			const duration = lastTs > firstTs ? lastTs - firstTs : 0;
			totalDurationSec += duration;

			if (sessionDate) {
				const ds = dailyStats.get(sessionDate) ?? { sessions: 0, turns: 0 };
				ds.sessions++;
				ds.turns += sessionTurns;
				dailyStats.set(sessionDate, ds);
			}

			const ps = projectStats.get(workDir) ?? { sessions: 0, turns: 0 };
			ps.sessions++;
			ps.turns += sessionTurns;
			projectStats.set(workDir, ps);
		}
	}

	// Build tool_usage: top 20 by count
	const toolUsage = [...toolStats.entries()]
		.map(([name, stats]) => ({
			name,
			count: stats.count,
			error_count: stats.error_count,
		}))
		.sort((a, b) => b.count - a.count)
		.slice(0, 20);

	// Build daily_usage: last 30 days
	const today = new Date();
	const dailyUsage: Array<Record<string, any>> = [];
	for (let i = 29; i >= 0; i--) {
		const d = new Date(today);
		d.setDate(d.getDate() - i);
		const dateStr = d.toISOString().slice(0, 10);
		const entry = dailyStats.get(dateStr) ?? { sessions: 0, turns: 0 };
		dailyUsage.push({
			date: dateStr,
			sessions: entry.sessions,
			turns: entry.turns,
		});
	}

	// Build per_project: top 10 by turns
	const perProject = [...projectStats.entries()]
		.map(([workDir, stats]) => ({
			work_dir: workDir,
			sessions: stats.sessions,
			turns: stats.turns,
		}))
		.sort((a, b) => b.turns - a.turns)
		.slice(0, 10);

	const result = {
		total_sessions: totalSessions,
		total_turns: totalTurns,
		total_tokens: { input: totalInputTokens, output: totalOutputTokens },
		total_duration_sec: totalDurationSec,
		tool_usage: toolUsage,
		daily_usage: dailyUsage,
		per_project: perProject,
	};

	_cache = { result, timestamp: now };
	return jsonResponse(result);
}
