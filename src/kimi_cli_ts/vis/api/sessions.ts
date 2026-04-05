/**
 * Vis API for reading session tracing data.
 * Corresponds to Python vis/api/sessions.py
 */

import { join, resolve, relative } from "node:path";
import {
	existsSync,
	statSync,
	readdirSync,
	readFileSync,
	mkdirSync,
	rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { getShareDir } from "../../share.ts";
import { loadMetadata } from "../../metadata.ts";
import { loadSessionState } from "../../session_state.ts";
import {
	parseWireFileLine,
	type WireFileMetadata,
	type WireMessageRecord,
} from "../../wire/file.ts";
import { logger } from "../../utils/logging.ts";

const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
const IMPORTED_HASH = "__imported__";

// ── Helpers ───────────────────────────────────────────────

function getImportedRoot(): string {
	return join(getShareDir(), "imported_sessions");
}

function findSessionDir(workDirHash: string, sessionId: string): string | null {
	if (!SESSION_ID_RE.test(sessionId)) return null;

	if (workDirHash === IMPORTED_HASH) {
		const sessionDir = join(getImportedRoot(), sessionId);
		if (existsSync(sessionDir) && statSync(sessionDir).isDirectory()) {
			return sessionDir;
		}
		return null;
	}

	if (!SESSION_ID_RE.test(workDirHash)) return null;

	const sessionsRoot = join(getShareDir(), "sessions");
	const sessionDir = join(sessionsRoot, workDirHash, sessionId);
	if (existsSync(sessionDir) && statSync(sessionDir).isDirectory()) {
		return sessionDir;
	}
	return null;
}

async function getWorkDirForHash(hashDirName: string): Promise<string | null> {
	try {
		const metadata = await loadMetadata();
		for (const wd of metadata.workDirs) {
			const pathMd5 = createHash("md5").update(wd.path, "utf-8").digest("hex");
			const dirBasename =
				wd.kaos === "local" ? pathMd5 : `${wd.kaos}_${pathMd5}`;
			if (dirBasename === hashDirName) {
				return wd.path;
			}
		}
	} catch {
		// Ignore
	}
	return null;
}

/**
 * Recursively unwrap SubagentEvent and collect (type, payload) pairs.
 */
export function collectEvents(
	msgType: string,
	payload: Record<string, any>,
	out: Array<{ type: string; payload: Record<string, any> }>,
): void {
	if (msgType === "SubagentEvent") {
		const inner = payload.event;
		if (inner && typeof inner === "object") {
			const innerType = inner.type ?? "";
			const innerPayload = inner.payload ?? {};
			if (innerType) {
				collectEvents(innerType, innerPayload, out);
			}
		}
	} else {
		out.push({ type: msgType, payload });
	}
}

// ── Wire parsing helpers ──────────────────────────────────

function isWireFileMetadata(
	parsed: WireFileMetadata | WireMessageRecord,
): parsed is WireFileMetadata {
	return "type" in parsed && (parsed as any).type === "metadata";
}

function extractTitleFromWire(
	wirePath: string,
	maxBytes = 8192,
): { title: string; turnCount: number } {
	let title = "";
	let turnCount = 0;

	try {
		const content = readFileSync(wirePath, "utf-8");
		let bytesRead = 0;

		for (const rawLine of content.split("\n")) {
			bytesRead += Buffer.byteLength(rawLine, "utf-8");
			const line = rawLine.trim();
			if (!line) continue;

			try {
				const parsed = parseWireFileLine(line);
				if (isWireFileMetadata(parsed)) continue;

				const record = parsed as WireMessageRecord;
				if (record.message.type === "TurnBegin") {
					turnCount++;
					if (turnCount === 1) {
						const userInput = record.message.payload?.user_input;
						if (typeof userInput === "string") {
							title = userInput.slice(0, 100);
						} else if (Array.isArray(userInput) && userInput.length > 0) {
							const first = userInput[0];
							if (typeof first === "object" && first !== null) {
								title = String(first.text ?? "").slice(0, 100);
							}
						}
					}
				}
			} catch {
				continue;
			}

			if (bytesRead > maxBytes) break;
		}
	} catch {
		// Ignore
	}

	return { title, turnCount };
}

// ── Session scanning ──────────────────────────────────────

async function scanSessionDir(
	sessionDir: string,
	workDirHash: string,
	workDir: string | null,
	imported = false,
): Promise<Record<string, any> | null> {
	if (!existsSync(sessionDir) || !statSync(sessionDir).isDirectory()) {
		return null;
	}

	const wirePath = join(sessionDir, "wire.jsonl");
	const contextPath = join(sessionDir, "context.jsonl");
	const statePath = join(sessionDir, "state.json");

	const wireExists = existsSync(wirePath);
	const contextExists = existsSync(contextPath);
	const stateExists = existsSync(statePath);

	const mtimes: number[] = [];
	let wireSize = 0;
	let contextSize = 0;
	let stateSize = 0;

	if (wireExists) {
		const st = statSync(wirePath);
		mtimes.push(st.mtimeMs / 1000);
		wireSize = st.size;
	}
	if (contextExists) {
		const st = statSync(contextPath);
		mtimes.push(st.mtimeMs / 1000);
		contextSize = st.size;
	}
	if (stateExists) {
		const st = statSync(statePath);
		mtimes.push(st.mtimeMs / 1000);
		stateSize = st.size;
	}

	const sessionState = await loadSessionState(sessionDir);

	let title = "";
	let turnCount = 0;
	if (wireExists) {
		const extracted = extractTitleFromWire(wirePath);
		title = extracted.title;
		turnCount = extracted.turnCount;
	}
	if (sessionState.custom_title) {
		title = sessionState.custom_title;
	}

	// Count sub-agents
	let subagentCount = 0;
	const subagentsDir = join(sessionDir, "subagents");
	if (existsSync(subagentsDir) && statSync(subagentsDir).isDirectory()) {
		subagentCount = readdirSync(subagentsDir).filter((name) => {
			const p = join(subagentsDir, name);
			return statSync(p).isDirectory();
		}).length;
	}

	const sessionId = sessionDir.split("/").pop() ?? "";

	return {
		session_id: sessionId,
		session_dir: sessionDir,
		work_dir: workDir,
		work_dir_hash: workDirHash,
		title,
		last_updated: mtimes.length > 0 ? Math.max(...mtimes) : 0,
		has_wire: wireExists,
		has_context: contextExists,
		has_state: stateExists,
		metadata: sessionState,
		wire_size: wireSize,
		context_size: contextSize,
		state_size: stateSize,
		total_size: wireSize + contextSize + stateSize,
		turns: turnCount,
		imported,
		subagent_count: subagentCount,
	};
}

async function listSessionsSync(): Promise<Array<Record<string, any>>> {
	const results: Array<Record<string, any>> = [];

	const sessionsRoot = join(getShareDir(), "sessions");
	if (existsSync(sessionsRoot)) {
		for (const workDirHashName of readdirSync(sessionsRoot)) {
			const workDirHashDir = join(sessionsRoot, workDirHashName);
			if (!statSync(workDirHashDir).isDirectory()) continue;

			const workDir = await getWorkDirForHash(workDirHashName);

			for (const sessionName of readdirSync(workDirHashDir)) {
				const sessionDir = join(workDirHashDir, sessionName);
				const info = await scanSessionDir(sessionDir, workDirHashName, workDir);
				if (info) results.push(info);
			}
		}
	}

	const importedRoot = getImportedRoot();
	if (existsSync(importedRoot)) {
		for (const sessionName of readdirSync(importedRoot)) {
			const sessionDir = join(importedRoot, sessionName);
			const info = await scanSessionDir(sessionDir, IMPORTED_HASH, null, true);
			if (info) results.push(info);
		}
	}

	results.sort((a, b) => b.last_updated - a.last_updated);
	return results;
}

// ── Wire/context reading helpers ──────────────────────────

async function readWireEvents(
	sessionDir: string,
): Promise<Record<string, any>> {
	const wirePath = join(sessionDir, "wire.jsonl");
	if (!existsSync(wirePath)) return { total: 0, events: [] };

	const content = await Bun.file(wirePath).text();
	const events: Array<Record<string, any>> = [];
	let index = 0;

	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		try {
			const parsed = parseWireFileLine(line);
			if (isWireFileMetadata(parsed)) continue;
			const record = parsed as WireMessageRecord;
			events.push({
				index,
				timestamp: record.timestamp,
				type: record.message.type,
				payload: record.message.payload,
			});
			index++;
		} catch {
			logger.debug(`Skipped malformed line in ${wirePath}`);
		}
	}

	return { total: events.length, events };
}

async function readContextMessages(
	sessionDir: string,
): Promise<Record<string, any>> {
	const contextPath = join(sessionDir, "context.jsonl");
	if (!existsSync(contextPath)) return { total: 0, messages: [] };

	const content = await Bun.file(contextPath).text();
	const messages: Array<Record<string, any>> = [];
	let index = 0;

	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		try {
			const msg = JSON.parse(line);
			msg.index = index;
			messages.push(msg);
			index++;
		} catch {
			logger.debug(`Skipped malformed line in ${contextPath}`);
		}
	}

	return { total: messages.length, messages };
}

async function readSessionState(
	sessionDir: string,
): Promise<Record<string, any>> {
	const statePath = join(sessionDir, "state.json");
	if (!existsSync(statePath)) return {};

	try {
		return JSON.parse(await Bun.file(statePath).text());
	} catch {
		return { error: "Invalid state.json" };
	}
}

async function computeSessionSummary(
	sessionDir: string,
): Promise<Record<string, any>> {
	const wirePath = join(sessionDir, "wire.jsonl");
	const contextPath = join(sessionDir, "context.jsonl");
	const statePath = join(sessionDir, "state.json");

	const wireSize = existsSync(wirePath) ? statSync(wirePath).size : 0;
	const contextSize = existsSync(contextPath) ? statSync(contextPath).size : 0;
	const stateSize = existsSync(statePath) ? statSync(statePath).size : 0;

	const zeros = {
		turns: 0,
		steps: 0,
		tool_calls: 0,
		errors: 0,
		compactions: 0,
		duration_sec: 0,
		input_tokens: 0,
		output_tokens: 0,
		wire_size: wireSize,
		context_size: contextSize,
		state_size: stateSize,
		total_size: wireSize + contextSize + stateSize,
	};

	if (!existsSync(wirePath)) return zeros;

	let turns = 0;
	let steps = 0;
	let toolCalls = 0;
	let errors = 0;
	let compactions = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let firstTs = 0;
	let lastTs = 0;

	const content = await Bun.file(wirePath).text();
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

		if (firstTs === 0) firstTs = ts;
		lastTs = ts;

		const eventsToProcess: Array<{
			type: string;
			payload: Record<string, any>;
		}> = [];
		collectEvents(msgType, payload, eventsToProcess);

		for (const ev of eventsToProcess) {
			switch (ev.type) {
				case "TurnBegin":
					turns++;
					break;
				case "StepBegin":
					steps++;
					break;
				case "ToolCall":
					toolCalls++;
					break;
				case "CompactionBegin":
					compactions++;
					break;
				case "StepInterrupted":
					errors++;
					break;
				case "ToolResult": {
					const rv = ev.payload.return_value;
					if (rv && typeof rv === "object" && rv.is_error) errors++;
					break;
				}
				case "ApprovalResponse":
					if (ev.payload.response === "reject") errors++;
					break;
				case "StatusUpdate": {
					const tu = ev.payload.token_usage;
					if (tu && typeof tu === "object") {
						inputTokens +=
							(Number(tu.input_other) || 0) +
							(Number(tu.input_cache_read) || 0) +
							(Number(tu.input_cache_creation) || 0);
						outputTokens += Number(tu.output) || 0;
					}
					break;
				}
			}
		}
	}

	return {
		turns,
		steps,
		tool_calls: toolCalls,
		errors,
		compactions,
		duration_sec: lastTs > firstTs ? lastTs - firstTs : 0,
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		wire_size: wireSize,
		context_size: contextSize,
		state_size: stateSize,
		total_size: wireSize + contextSize + stateSize,
	};
}

// ── Subagent helpers ──────────────────────────────────────

function listSubagents(sessionDir: string): Array<Record<string, any>> {
	const subagentsDir = join(sessionDir, "subagents");
	if (!existsSync(subagentsDir) || !statSync(subagentsDir).isDirectory()) {
		return [];
	}

	const results: Array<Record<string, any>> = [];
	for (const entry of readdirSync(subagentsDir)) {
		const entryPath = join(subagentsDir, entry);
		if (!statSync(entryPath).isDirectory()) continue;
		if (!SESSION_ID_RE.test(entry)) continue;

		let meta: Record<string, any> = {};
		const metaPath = join(entryPath, "meta.json");
		if (existsSync(metaPath)) {
			try {
				meta = JSON.parse(readFileSync(metaPath, "utf-8"));
			} catch {
				// Ignore
			}
		}

		const wirePath = join(entryPath, "wire.jsonl");
		const contextPath = join(entryPath, "context.jsonl");

		results.push({
			agent_id: meta.agent_id ?? entry,
			subagent_type: meta.subagent_type ?? "unknown",
			status: meta.status ?? "unknown",
			description: meta.description ?? "",
			created_at: meta.created_at ?? 0,
			updated_at: meta.updated_at ?? 0,
			last_task_id: meta.last_task_id ?? null,
			launch_spec: meta.launch_spec ?? {},
			wire_size: existsSync(wirePath) ? statSync(wirePath).size : 0,
			context_size: existsSync(contextPath) ? statSync(contextPath).size : 0,
		});
	}

	results.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
	return results;
}

// ── Download / Import / Delete ────────────────────────────

async function downloadSession(
	sessionDir: string,
	sessionId: string,
): Promise<Response> {
	// Use Bun's zip utilities or node:child_process for zip creation
	const { execSync } = await import("node:child_process");

	// Create zip in a temp file
	const tmpZip = join(
		require("node:os").tmpdir(),
		`session-${sessionId}-${Date.now()}.zip`,
	);
	try {
		execSync(`cd "${sessionDir}" && zip -r "${tmpZip}" .`, { stdio: "pipe" });
		const zipContent = readFileSync(tmpZip);
		rmSync(tmpZip, { force: true });

		return new Response(zipContent, {
			headers: {
				"Content-Type": "application/zip",
				"Content-Disposition": `attachment; filename="session-${sessionId}.zip"`,
				"Access-Control-Allow-Origin": "*",
			},
		});
	} catch (err) {
		rmSync(tmpZip, { force: true });
		throw err;
	}
}

async function importSession(req: Request): Promise<Response> {
	const formData = await req.formData();
	const file = formData.get("file");

	if (!(file instanceof File) || !file.name.endsWith(".zip")) {
		return jsonResponse({ detail: "Only .zip files are accepted" }, 400);
	}

	const content = await file.arrayBuffer();
	if (content.byteLength === 0) {
		return jsonResponse({ detail: "Empty file" }, 400);
	}

	const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
	if (content.byteLength > MAX_UPLOAD_BYTES) {
		return jsonResponse({ detail: "File too large (max 200 MB)" }, 413);
	}

	// Generate session ID and extract
	const { randomBytes } = await import("node:crypto");
	const sessionId = randomBytes(8).toString("hex");
	const importedRoot = getImportedRoot();
	const sessionDir = join(importedRoot, sessionId);
	mkdirSync(sessionDir, { recursive: true });

	try {
		// Write zip to temp, extract with unzip
		const tmpZip = join(require("node:os").tmpdir(), `import-${sessionId}.zip`);
		await Bun.write(tmpZip, content);

		const { execSync } = await import("node:child_process");
		execSync(`unzip -o "${tmpZip}" -d "${sessionDir}"`, { stdio: "pipe" });
		rmSync(tmpZip, { force: true });

		// Flatten if all files are under a single subdirectory
		const entries = readdirSync(sessionDir);
		if (entries.length === 1) {
			const nested = join(sessionDir, entries[0]!);
			if (statSync(nested).isDirectory()) {
				for (const item of readdirSync(nested)) {
					const { renameSync } = require("node:fs");
					renameSync(join(nested, item), join(sessionDir, item));
				}
				rmSync(nested, { recursive: true });
			}
		}

		// Verify it has wire.jsonl or context.jsonl
		const hasValid =
			existsSync(join(sessionDir, "wire.jsonl")) ||
			existsSync(join(sessionDir, "context.jsonl"));
		if (!hasValid) {
			rmSync(sessionDir, { recursive: true, force: true });
			return jsonResponse(
				{
					detail:
						"ZIP must contain wire.jsonl or context.jsonl at the top level (or inside a single directory)",
				},
				400,
			);
		}
	} catch (err) {
		rmSync(sessionDir, { recursive: true, force: true });
		return jsonResponse({ detail: "Failed to extract ZIP file" }, 400);
	}

	return jsonResponse({ session_id: sessionId, work_dir_hash: IMPORTED_HASH });
}

function deleteSession(sessionId: string): Response {
	if (!SESSION_ID_RE.test(sessionId)) {
		return jsonResponse({ detail: "Invalid session ID" }, 400);
	}

	const sessionDir = join(getImportedRoot(), sessionId);
	if (!existsSync(sessionDir) || !statSync(sessionDir).isDirectory()) {
		return jsonResponse({ detail: "Session not found" }, 404);
	}

	rmSync(sessionDir, { recursive: true });
	return jsonResponse({ status: "deleted" });
}

// ── JSON response helper ──────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Access-Control-Allow-Origin": "*",
		},
	});
}

function errorResponse(status: number, detail: string): Response {
	return jsonResponse({ detail }, status);
}

// ── Route handler ─────────────────────────────────────────

/**
 * Handle all /api/vis/sessions routes.
 * @param apiPath - path after /api/vis (e.g. "/sessions", "/sessions/{hash}/{id}/wire")
 */
export async function handleSessionsRoute(
	req: Request,
	url: URL,
	apiPath: string,
): Promise<Response> {
	// GET /sessions
	if (apiPath === "/sessions" && req.method === "GET") {
		const sessions = await listSessionsSync();
		return jsonResponse(sessions);
	}

	// POST /sessions/import
	if (apiPath === "/sessions/import" && req.method === "POST") {
		return importSession(req);
	}

	// Parse /sessions/{workDirHash}/{sessionId}...
	const parts = apiPath.split("/").filter(Boolean); // ["sessions", hash, id, ...]
	if (parts.length < 3 || parts[0] !== "sessions") {
		return errorResponse(404, "Not found");
	}

	const workDirHash = parts[1]!;
	const sessionId = parts[2]!;
	const rest = parts.slice(3).join("/"); // e.g. "wire", "context", "state", "summary", "subagents", etc.

	// DELETE /sessions/{hash}/{id}
	if (req.method === "DELETE" && rest === "") {
		if (workDirHash !== IMPORTED_HASH) {
			return errorResponse(403, "Only imported sessions can be deleted");
		}
		return deleteSession(sessionId);
	}

	const sessionDir = findSessionDir(workDirHash, sessionId);
	if (!sessionDir) {
		return errorResponse(404, "Session not found");
	}

	// GET /sessions/{hash}/{id}/wire
	if (rest === "wire" && req.method === "GET") {
		return jsonResponse(await readWireEvents(sessionDir));
	}

	// GET /sessions/{hash}/{id}/context
	if (rest === "context" && req.method === "GET") {
		return jsonResponse(await readContextMessages(sessionDir));
	}

	// GET /sessions/{hash}/{id}/state
	if (rest === "state" && req.method === "GET") {
		return jsonResponse(await readSessionState(sessionDir));
	}

	// GET /sessions/{hash}/{id}/summary
	if (rest === "summary" && req.method === "GET") {
		return jsonResponse(await computeSessionSummary(sessionDir));
	}

	// GET /sessions/{hash}/{id}/download
	if (rest === "download" && req.method === "GET") {
		return downloadSession(sessionDir, sessionId);
	}

	// GET /sessions/{hash}/{id}/subagents
	if (rest === "subagents" && req.method === "GET") {
		return jsonResponse(listSubagents(sessionDir));
	}

	// Subagent routes: /sessions/{hash}/{id}/subagents/{agentId}/{resource}
	if (parts.length >= 5 && parts[3] === "subagents") {
		const agentId = parts[4]!;
		if (!SESSION_ID_RE.test(agentId)) {
			return errorResponse(400, "Invalid agent ID");
		}

		const subResource = parts[5] ?? "";

		// GET .../subagents/{agentId}/wire
		if (subResource === "wire" && req.method === "GET") {
			const subDir = join(sessionDir, "subagents", agentId);
			const wirePath = join(subDir, "wire.jsonl");
			if (!existsSync(wirePath)) return jsonResponse({ total: 0, events: [] });

			const content = await Bun.file(wirePath).text();
			const events: Array<Record<string, any>> = [];
			let index = 0;
			for (const rawLine of content.split("\n")) {
				const line = rawLine.trim();
				if (!line) continue;
				try {
					const parsed = parseWireFileLine(line);
					if (isWireFileMetadata(parsed)) continue;
					const record = parsed as WireMessageRecord;
					events.push({
						index,
						timestamp: record.timestamp,
						type: record.message.type,
						payload: record.message.payload,
					});
					index++;
				} catch {
					// skip
				}
			}
			return jsonResponse({ total: events.length, events });
		}

		// GET .../subagents/{agentId}/context
		if (subResource === "context" && req.method === "GET") {
			const contextPath = join(
				sessionDir,
				"subagents",
				agentId,
				"context.jsonl",
			);
			if (!existsSync(contextPath))
				return jsonResponse({ total: 0, messages: [] });

			const content = await Bun.file(contextPath).text();
			const messages: Array<Record<string, any>> = [];
			let index = 0;
			for (const rawLine of content.split("\n")) {
				const line = rawLine.trim();
				if (!line) continue;
				try {
					const msg = JSON.parse(line);
					msg.index = index;
					messages.push(msg);
					index++;
				} catch {
					// skip
				}
			}
			return jsonResponse({ total: messages.length, messages });
		}

		// GET .../subagents/{agentId}/meta
		if (subResource === "meta" && req.method === "GET") {
			const metaPath = join(sessionDir, "subagents", agentId, "meta.json");
			if (!existsSync(metaPath))
				return errorResponse(404, "Sub-agent not found");
			try {
				return jsonResponse(JSON.parse(await Bun.file(metaPath).text()));
			} catch {
				return errorResponse(500, "Invalid meta.json");
			}
		}
	}

	return errorResponse(404, "Not found");
}
