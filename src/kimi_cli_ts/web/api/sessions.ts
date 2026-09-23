/**
 * Web API sessions — corresponds to Python web/api/sessions.py
 * Session CRUD, file access, WebSocket streaming, work dirs, git diff.
 */

import { join, resolve, relative, basename, dirname } from "node:path";
import {
	existsSync,
	statSync,
	readdirSync,
	readFileSync,
	lstatSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type { KimiCLIRunner, SessionProcess } from "../runner/process.ts";
import {
	loadSessionsPage,
	loadSessionById,
	getSessionIndexEntry,
	invalidateSessionsCache,
	runAutoArchive,
	listWorkDirs,
} from "../store/sessions.ts";
import { loadSessionState, saveSessionState } from "../../session_state.ts";
import { sendHistoryComplete } from "../runner/messages.ts";
import type {
	WebSession,
	UpdateSessionRequest,
	CreateSessionRequest,
	ForkSessionRequest,
	GitDiffStats,
	GitFileDiff,
} from "../models.ts";
import { logger } from "../../utils/logging.ts";
import { Session } from "../../session.ts";
import {
	loadMetadata,
	getSessionsDir,
	getWorkDirMeta,
	newWorkDirMeta,
	saveMetadata,
} from "../../metadata.ts";

// ── Security constants ───────────────────────────────────

const SENSITIVE_PATH_PARTS = new Set([
	".env",
	".git",
	"node_modules",
	"__pycache__",
	".ssh",
	".gnupg",
	".aws",
	".kube",
	".docker",
]);

const SENSITIVE_PATH_EXTENSIONS = new Set([
	".pem",
	".key",
	".p12",
	".pfx",
	".jks",
	".keystore",
]);

const SENSITIVE_HOME_PATHS = new Set([
	".bashrc",
	".zshrc",
	".bash_profile",
	".profile",
	".netrc",
	".npmrc",
	".pypirc",
]);

const DEFAULT_MAX_PUBLIC_PATH_DEPTH = 6;

// ── Security helpers ─────────────────────────────────────

function sanitizeFilename(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "_");
}

function relativeParts(basePath: string, targetPath: string): string[] {
	const rel = relative(basePath, targetPath);
	return rel.split("/").filter(Boolean);
}

function isSensitiveRelativePath(parts: string[]): boolean {
	for (const part of parts) {
		if (SENSITIVE_PATH_PARTS.has(part)) return true;
		const ext = part.includes(".") ? `.${part.split(".").pop()}` : "";
		if (SENSITIVE_PATH_EXTENSIONS.has(ext)) return true;
	}
	return false;
}

function containsSymlink(path: string): boolean {
	const parts = path.split("/");
	let current = "/";
	for (const part of parts) {
		if (!part) continue;
		current = join(current, part);
		try {
			if (lstatSync(current).isSymbolicLink()) return true;
		} catch {
			return false;
		}
	}
	return false;
}

function isPathInSensitiveLocation(path: string): boolean {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	if (home && path.startsWith(home)) {
		const rel = relative(home, path);
		const first = rel.split("/")[0];
		if (first && SENSITIVE_HOME_PATHS.has(first)) return true;
	}
	return false;
}

function ensurePublicFileAccessAllowed(
	filePath: string,
	workDir: string,
	maxDepth: number,
): string | null {
	const resolved = resolve(filePath);

	// Must be within work dir
	if (
		!resolved.startsWith(resolve(workDir) + "/") &&
		resolved !== resolve(workDir)
	) {
		return "Path traversal detected";
	}

	// Symlink check
	if (containsSymlink(resolved)) {
		return "Symlink traversal not allowed";
	}

	// Depth check
	const parts = relativeParts(workDir, resolved);
	if (parts.length > maxDepth) {
		return `Path depth exceeds limit (${maxDepth})`;
	}

	// Sensitive path check
	if (isSensitiveRelativePath(parts)) {
		return "Access to sensitive path denied";
	}

	if (isPathInSensitiveLocation(resolved)) {
		return "Access to sensitive location denied";
	}

	return null;
}

// ── Wire replay ──────────────────────────────────────────

function readWireLines(wireFile: string): string[] {
	if (!existsSync(wireFile)) return [];

	const lines: string[] = [];
	try {
		const text = readFileSync(wireFile, "utf-8");
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			// Wrap each wire event in a JSON-RPC event envelope
			try {
				const event = JSON.parse(trimmed);
				const envelope = {
					jsonrpc: "2.0",
					method: "event",
					params: event,
				};
				lines.push(JSON.stringify(envelope));
			} catch {
				continue;
			}
		}
	} catch {
		// ignore
	}
	return lines;
}

function replayHistory(ws: ServerWebSocket<unknown>, sessionDir: string): void {
	const wireFile = join(sessionDir, "wire.jsonl");
	const lines = readWireLines(wireFile);
	for (const line of lines) {
		try {
			ws.send(line);
		} catch {
			break;
		}
	}
	sendHistoryComplete(ws);
}

// ── Helpers ──────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "*",
			"Access-Control-Allow-Headers": "*",
		},
	});
}

// ── Git diff ─────────────────────────────────────────────

async function getGitDiffStats(workDir: string): Promise<GitDiffStats> {
	const result: GitDiffStats = {
		is_git_repo: false,
		has_changes: false,
		total_additions: 0,
		total_deletions: 0,
		files: [],
		error: null,
	};

	try {
		// Check if git repo
		const gitCheck = Bun.spawnSync(
			["git", "rev-parse", "--is-inside-work-tree"],
			{
				cwd: workDir,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		if (gitCheck.exitCode !== 0) return result;
		result.is_git_repo = true;

		// Get diff stats
		const diff = Bun.spawnSync(["git", "diff", "--numstat", "HEAD"], {
			cwd: workDir,
			stdout: "pipe",
			stderr: "pipe",
		});

		const output = new TextDecoder().decode(diff.stdout).trim();
		if (!output) return result;

		for (const line of output.split("\n")) {
			const parts = line.split("\t");
			if (parts.length < 3) continue;

			const additions =
				parts[0] === "-" ? 0 : Number.parseInt(parts[0]!, 10) || 0;
			const deletions =
				parts[1] === "-" ? 0 : Number.parseInt(parts[1]!, 10) || 0;
			const path = parts[2]!;

			const file: GitFileDiff = {
				path,
				additions,
				deletions,
				status:
					additions > 0 && deletions === 0
						? "added"
						: deletions > 0 && additions === 0
							? "deleted"
							: "modified",
			};

			result.files.push(file);
			result.total_additions += additions;
			result.total_deletions += deletions;
		}

		result.has_changes = result.files.length > 0;
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err);
	}

	return result;
}

// ── Route handler ────────────────────────────────────────

export async function handleSessionsRoute(
	req: Request,
	url: URL,
	apiPath: string,
	runner: KimiCLIRunner,
	restrictSensitiveApis: boolean,
	maxPublicPathDepth: number = DEFAULT_MAX_PUBLIC_PATH_DEPTH,
): Promise<Response> {
	// GET /api/sessions/ — list sessions
	if (apiPath === "/sessions" && req.method === "GET") {
		// Trigger auto-archive (non-blocking)
		runAutoArchive().catch(() => {});

		const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
		const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
		const query = url.searchParams.get("query") ?? undefined;
		const archivedParam = url.searchParams.get("archived");
		const archived =
			archivedParam !== null ? archivedParam === "true" : undefined;

		const result = loadSessionsPage(limit, offset, query, archived);
		return jsonResponse(result);
	}

	// POST /api/sessions/ — create session
	if (apiPath === "/sessions" && req.method === "POST") {
		let body: CreateSessionRequest = {};
		try {
			body = (await req.json()) as CreateSessionRequest;
		} catch {
			// empty body is ok
		}

		const workDir = resolve(body.work_dir ?? process.cwd());

		if (body.create_dir && !existsSync(workDir)) {
			try {
				mkdirSync(workDir, { recursive: true });
			} catch (err) {
				return jsonResponse(
					{
						detail: `Failed to create directory: ${err instanceof Error ? err.message : err}`,
					},
					400,
				);
			}
		}

		if (!existsSync(workDir)) {
			return jsonResponse(
				{ detail: `Work directory does not exist: ${workDir}` },
				400,
			);
		}

		try {
			const session = await Session.create(workDir);
			invalidateSessionsCache();
			const ws: WebSession = {
				session_id: session.id,
				title: session.title,
				last_updated: new Date().toISOString(),
				is_running: false,
				status: null,
				work_dir: workDir,
				session_dir: session.dir,
				archived: false,
			};
			return jsonResponse(ws, 201);
		} catch (err) {
			return jsonResponse(
				{
					detail: `Failed to create session: ${err instanceof Error ? err.message : err}`,
				},
				500,
			);
		}
	}

	// ── Session-specific routes (/sessions/{id}/...) ───────

	const sessionIdMatch = apiPath.match(/^\/sessions\/([^/]+)(\/.*)?$/);
	if (!sessionIdMatch) {
		// Check for work-dirs routes
		return handleWorkDirsRoute(req, url, apiPath);
	}

	const sessionId = sessionIdMatch[1]!;
	const subPath = sessionIdMatch[2] ?? "";

	// GET /api/sessions/{id}
	if (!subPath && req.method === "GET") {
		const session = loadSessionById(sessionId);
		if (!session) return jsonResponse({ detail: "Session not found" }, 404);
		return jsonResponse(session);
	}

	// DELETE /api/sessions/{id}
	if (!subPath && req.method === "DELETE") {
		const entry = getSessionIndexEntry(sessionId);
		if (!entry) return jsonResponse({ detail: "Session not found" }, 404);

		// Stop the worker if running
		const sp = runner.getSession(sessionId);
		if (sp) await sp.stop();

		// Delete session directory
		try {
			await Bun.$`rm -rf ${entry.sessionDir}`.quiet();
		} catch {
			// ignore
		}

		invalidateSessionsCache();
		return jsonResponse({ ok: true });
	}

	// PATCH /api/sessions/{id}
	if (!subPath && req.method === "PATCH") {
		const entry = getSessionIndexEntry(sessionId);
		if (!entry) return jsonResponse({ detail: "Session not found" }, 404);

		let body: UpdateSessionRequest;
		try {
			body = (await req.json()) as UpdateSessionRequest;
		} catch {
			return jsonResponse({ detail: "Invalid JSON body" }, 400);
		}

		const state = await loadSessionState(entry.sessionDir);
		let changed = false;

		if (body.title !== undefined) {
			if (body.title.length < 1 || body.title.length > 200) {
				return jsonResponse({ detail: "Title must be 1-200 characters" }, 400);
			}
			state.custom_title = body.title;
			changed = true;
		}

		if (body.archived !== undefined) {
			state.archived = body.archived;
			if (body.archived) {
				state.archived_at = Date.now() / 1000;
			} else {
				state.archived_at = null;
			}
			changed = true;
		}

		if (changed) {
			await saveSessionState(state, entry.sessionDir);
			invalidateSessionsCache();
		}

		const session = loadSessionById(sessionId);
		return jsonResponse(session);
	}

	// POST /api/sessions/{id}/files — upload file
	if (subPath === "/files" && req.method === "POST") {
		const entry = getSessionIndexEntry(sessionId);
		if (!entry) return jsonResponse({ detail: "Session not found" }, 404);

		const contentType = req.headers.get("content-type") ?? "";
		if (!contentType.includes("multipart/form-data")) {
			return jsonResponse({ detail: "Expected multipart/form-data" }, 400);
		}

		try {
			const formData = await req.formData();
			const file = formData.get("file") as File | null;
			if (!file) return jsonResponse({ detail: "No file uploaded" }, 400);

			// 100MB limit
			if (file.size > 100 * 1024 * 1024) {
				return jsonResponse({ detail: "File too large (max 100MB)" }, 400);
			}

			const uploadsDir = join(entry.sessionDir, "uploads");
			mkdirSync(uploadsDir, { recursive: true });

			const safeName = sanitizeFilename(file.name);
			const filePath = join(uploadsDir, safeName);
			const content = await file.arrayBuffer();
			writeFileSync(filePath, Buffer.from(content));

			return jsonResponse(
				{
					filename: safeName,
					size: file.size,
					content_type: file.type,
					path: filePath,
				},
				201,
			);
		} catch (err) {
			return jsonResponse(
				{
					detail: `Upload failed: ${err instanceof Error ? err.message : err}`,
				},
				500,
			);
		}
	}

	// GET /api/sessions/{id}/uploads/{path} — get uploaded file
	const uploadsMatch = subPath.match(/^\/uploads\/(.+)$/);
	if (uploadsMatch && req.method === "GET") {
		const entry = getSessionIndexEntry(sessionId);
		if (!entry) return jsonResponse({ detail: "Session not found" }, 404);

		const uploadsDir = join(entry.sessionDir, "uploads");
		const filePath = join(uploadsDir, uploadsMatch[1]!);
		const resolved = resolve(filePath);

		// Path traversal protection
		if (!resolved.startsWith(resolve(uploadsDir))) {
			return jsonResponse({ detail: "Path traversal detected" }, 403);
		}

		if (!existsSync(resolved)) {
			return jsonResponse({ detail: "File not found" }, 404);
		}

		const content = readFileSync(resolved);
		return new Response(content, {
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Disposition": `attachment; filename="${basename(resolved)}"`,
			},
		});
	}

	// GET /api/sessions/{id}/files/{path} — get file from work dir
	const filesMatch = subPath.match(/^\/files\/(.+)$/);
	if (filesMatch && req.method === "GET") {
		const entry = getSessionIndexEntry(sessionId);
		if (!entry) return jsonResponse({ detail: "Session not found" }, 404);

		const requestedPath = filesMatch[1]!;
		const filePath = resolve(join(entry.workDir, requestedPath));

		// Security check
		const securityError = ensurePublicFileAccessAllowed(
			filePath,
			entry.workDir,
			maxPublicPathDepth,
		);
		if (securityError) {
			return jsonResponse({ detail: securityError }, 403);
		}

		if (!existsSync(filePath)) {
			return jsonResponse({ detail: "File not found" }, 404);
		}

		const stat = statSync(filePath);
		if (!stat.isFile()) {
			return jsonResponse({ detail: "Not a file" }, 400);
		}

		const content = readFileSync(filePath);
		return new Response(content, {
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Disposition": `attachment; filename="${basename(filePath)}"`,
			},
		});
	}

	// POST /api/sessions/{id}/fork
	if (subPath === "/fork" && req.method === "POST") {
		const entry = getSessionIndexEntry(sessionId);
		if (!entry) return jsonResponse({ detail: "Session not found" }, 404);

		let body: ForkSessionRequest;
		try {
			body = (await req.json()) as ForkSessionRequest;
		} catch {
			return jsonResponse({ detail: "Invalid JSON body" }, 400);
		}

		try {
			// Create new session
			const newSession = await Session.create(entry.workDir);

			// Copy context up to turn_index
			const contextFile = entry.contextFile;
			if (existsSync(contextFile)) {
				const text = readFileSync(contextFile, "utf-8");
				const lines = text.split("\n").filter(Boolean);
				let turnCount = 0;
				const forkedLines: string[] = [];

				for (const line of lines) {
					try {
						const record = JSON.parse(line);
						if (record.role === "user") turnCount++;
						if (turnCount > body.turn_index) break;
						forkedLines.push(line);
					} catch {
						forkedLines.push(line);
					}
				}

				writeFileSync(newSession.contextFile, forkedLines.join("\n") + "\n");
			}

			invalidateSessionsCache();

			const ws: WebSession = {
				session_id: newSession.id,
				title: `Fork of ${entry.title}`,
				last_updated: new Date().toISOString(),
				is_running: false,
				status: null,
				work_dir: entry.workDir,
				session_dir: newSession.dir,
				archived: false,
			};
			return jsonResponse(ws, 201);
		} catch (err) {
			return jsonResponse(
				{ detail: `Fork failed: ${err instanceof Error ? err.message : err}` },
				500,
			);
		}
	}

	// POST /api/sessions/{id}/generate-title
	if (subPath === "/generate-title" && req.method === "POST") {
		const entry = getSessionIndexEntry(sessionId);
		if (!entry) return jsonResponse({ detail: "Session not found" }, 404);

		// Simple title generation: use first user message
		let title = entry.title;
		if (title === "Untitled" || !title) {
			const wireFile = join(entry.sessionDir, "wire.jsonl");
			if (existsSync(wireFile)) {
				const text = readFileSync(wireFile, "utf-8");
				for (const line of text.split("\n")) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					try {
						const record = JSON.parse(trimmed);
						if (record.type === "turn_begin" && record.user_input) {
							title =
								typeof record.user_input === "string"
									? record.user_input.slice(0, 50)
									: JSON.stringify(record.user_input).slice(0, 50);
							break;
						}
					} catch {
						continue;
					}
				}
			}
		}

		// Save as custom title
		const state = await loadSessionState(entry.sessionDir);
		state.custom_title = title;
		state.title_generated = true;
		state.title_generate_attempts = (state.title_generate_attempts ?? 0) + 1;
		await saveSessionState(state, entry.sessionDir);
		invalidateSessionsCache();

		return jsonResponse({ title });
	}

	// GET /api/sessions/{id}/git-diff
	if (subPath === "/git-diff" && req.method === "GET") {
		const entry = getSessionIndexEntry(sessionId);
		if (!entry) return jsonResponse({ detail: "Session not found" }, 404);

		const stats = await getGitDiffStats(entry.workDir);
		return jsonResponse(stats);
	}

	return jsonResponse({ detail: "Not found" }, 404);
}

// ── WebSocket session stream handler ─────────────────────

export function handleSessionStream(
	ws: ServerWebSocket<{ sessionId: string }>,
	runner: KimiCLIRunner,
): void {
	const { sessionId } = ws.data;
	const entry = getSessionIndexEntry(sessionId);
	if (!entry) {
		ws.close(4004, "Session not found");
		return;
	}

	const sp = runner.getOrCreateSession(sessionId, entry.sessionDir);

	// Replay history first
	replayHistory(ws, entry.sessionDir);

	// Then attach to live stream
	sp.addWebsocketAndBeginReplay(ws as ServerWebSocket<unknown>);
	sp.endReplay(ws as ServerWebSocket<unknown>);
}

export function handleSessionStreamMessage(
	ws: ServerWebSocket<{ sessionId: string }>,
	message: string,
	runner: KimiCLIRunner,
): void {
	const { sessionId } = ws.data;
	const sp = runner.getSession(sessionId);
	if (!sp) return;

	sp.sendMessage(message).catch((err) => {
		logger.warn(`Failed to send message to worker: ${err}`);
	});
}

export function handleSessionStreamClose(
	ws: ServerWebSocket<{ sessionId: string }>,
	runner: KimiCLIRunner,
): void {
	runner.detachWebsocket(ws as ServerWebSocket<unknown>);
}

// ── Work dirs routes ─────────────────────────────────────

function handleWorkDirsRoute(
	req: Request,
	url: URL,
	apiPath: string,
): Response {
	// GET /api/work-dirs/
	if (apiPath === "/work-dirs" && req.method === "GET") {
		const dirs = listWorkDirs();
		return jsonResponse({ work_dirs: dirs });
	}

	// GET /api/work-dirs/startup
	if (apiPath === "/work-dirs/startup" && req.method === "GET") {
		return jsonResponse({ work_dir: process.cwd() });
	}

	return jsonResponse({ detail: "Not found" }, 404);
}
