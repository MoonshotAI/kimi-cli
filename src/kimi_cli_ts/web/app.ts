/**
 * Kimi Web Server application — corresponds to Python web/app.py
 * Uses Bun.serve instead of FastAPI + uvicorn.
 */

import { join, resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import {
	findAvailablePort,
	formatUrl,
	getNetworkAddresses,
	isLocalHost,
	printBanner,
} from "../utils/server.ts";
import { authCheck, normalizeAllowedOrigins, type AuthConfig } from "./auth.ts";
import { KimiCLIRunner } from "./runner/process.ts";
import {
	handleSessionsRoute,
	handleSessionStream,
	handleSessionStreamMessage,
	handleSessionStreamClose,
} from "./api/sessions.ts";
import { handleConfigRoute } from "./api/config.ts";
import { handleOpenInRoute } from "./api/open_in.ts";
import { handleStatisticsRoute } from "../vis/api/statistics.ts";
import { handleSystemRoute } from "../vis/api/system.ts";

// ── Constants ────────────────────────────────────────────

const STATIC_DIR = join(
	import.meta.dir,
	"..",
	"..",
	"kimi_cli",
	"web",
	"static",
);
const DEFAULT_PORT = 5494;
const GZIP_MINIMUM_SIZE = 1024;

// ── Environment variables ────────────────────────────────

const ENV_SESSION_TOKEN = "KIMI_WEB_SESSION_TOKEN";
const ENV_ALLOWED_ORIGINS = "KIMI_WEB_ALLOWED_ORIGINS";
const ENV_ENFORCE_ORIGIN = "KIMI_WEB_ENFORCE_ORIGIN";
const ENV_RESTRICT_SENSITIVE_APIS = "KIMI_WEB_RESTRICT_SENSITIVE_APIS";
const ENV_MAX_PUBLIC_PATH_DEPTH = "KIMI_WEB_MAX_PUBLIC_PATH_DEPTH";
const ENV_LAN_ONLY = "KIMI_WEB_LAN_ONLY";

// ── App state ────────────────────────────────────────────

export interface WebAppState {
	runner: KimiCLIRunner;
	auth: AuthConfig;
	restrictSensitiveApis: boolean;
	restrictOpenIn: boolean;
	maxPublicPathDepth: number;
}

// ── MIME helper ──────────────────────────────────────────

function getMimeType(path: string): string {
	if (path.endsWith(".html")) return "text/html; charset=utf-8";
	if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
	if (path.endsWith(".css")) return "text/css; charset=utf-8";
	if (path.endsWith(".json")) return "application/json; charset=utf-8";
	if (path.endsWith(".svg")) return "image/svg+xml";
	if (path.endsWith(".png")) return "image/png";
	if (path.endsWith(".ico")) return "image/x-icon";
	if (path.endsWith(".woff2")) return "font/woff2";
	if (path.endsWith(".woff")) return "font/woff";
	return "application/octet-stream";
}

// ── CORS / response helpers ──────────────────────────────

function corsHeaders(): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "*",
		"Access-Control-Allow-Headers": "*",
		"Access-Control-Allow-Credentials": "true",
	};
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			...corsHeaders(),
		},
	});
}

function errorResponse(status: number, detail: string): Response {
	return jsonResponse({ detail }, status);
}

// ── Static file serving with cache headers ───────────────

function serveStaticFile(pathname: string): Response | null {
	if (!existsSync(STATIC_DIR)) return null;

	let filePath = join(STATIC_DIR, pathname);

	// Try exact path, then index.html for SPA
	if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
		filePath = join(STATIC_DIR, "index.html");
		if (!existsSync(filePath)) return null;
	}

	const content = readFileSync(filePath);

	// Cache headers: assets/ → immutable 1yr, .html → no-cache
	let cacheControl = "no-cache";
	if (pathname.startsWith("/assets/")) {
		cacheControl = "public, max-age=31536000, immutable";
	}

	return new Response(content, {
		headers: {
			"Content-Type": getMimeType(filePath),
			"Cache-Control": cacheControl,
			...corsHeaders(),
		},
	});
}

// ── Server factory ───────────────────────────────────────

export function createWebServer(
	host: string,
	port: number,
	state: WebAppState,
): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		hostname: host,
		port,
		async fetch(req, server) {
			const url = new URL(req.url);
			const { pathname } = url;

			// CORS preflight
			if (req.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: corsHeaders() });
			}

			// Health check
			if (pathname === "/healthz" && req.method === "GET") {
				return jsonResponse({ status: "ok" });
			}

			// Auth check for API routes
			const authResult = authCheck(req, url, state.auth, server);
			if (authResult) return authResult;

			// ── WebSocket upgrade for /api/sessions/{id}/stream ──
			const wsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
			if (
				wsMatch &&
				req.headers.get("upgrade")?.toLowerCase() === "websocket"
			) {
				const sessionId = wsMatch[1]!;
				const upgraded = server.upgrade(req, {
					data: { sessionId },
				});
				if (!upgraded) {
					return errorResponse(500, "WebSocket upgrade failed");
				}
				return undefined as unknown as Response;
			}

			// ── API routes ──

			// Sessions routes
			if (
				pathname.startsWith("/api/sessions") ||
				pathname.startsWith("/api/work-dirs")
			) {
				const apiPath = pathname.slice("/api".length);
				return handleSessionsRoute(
					req,
					url,
					apiPath,
					state.runner,
					state.restrictSensitiveApis,
					state.maxPublicPathDepth,
				);
			}

			// Config routes
			if (pathname.startsWith("/api/config")) {
				const apiPath = pathname.slice("/api".length);
				return handleConfigRoute(
					req,
					url,
					apiPath,
					state.runner,
					state.restrictSensitiveApis,
				);
			}

			// Open-in API (only in local mode)
			if (
				pathname === "/api/open-in" &&
				req.method === "POST" &&
				!state.restrictOpenIn
			) {
				return handleOpenInRoute(req);
			}

			// Vis API routes (reuse from vis module)
			if (pathname.startsWith("/api/vis/")) {
				const apiPath = pathname.slice("/api/vis".length);

				if (apiPath === "/statistics" && req.method === "GET") {
					return handleStatisticsRoute();
				}

				if (apiPath === "/capabilities" && req.method === "GET") {
					return handleSystemRoute({
						restrictOpenIn: state.restrictOpenIn,
					});
				}
			}

			// ── Static files ──
			const staticResponse = serveStaticFile(pathname);
			if (staticResponse) return staticResponse;

			return errorResponse(404, "Not found");
		},

		websocket: {
			open(ws: ServerWebSocket<{ sessionId: string }>) {
				handleSessionStream(ws, state.runner);
			},
			message(
				ws: ServerWebSocket<{ sessionId: string }>,
				message: string | Buffer,
			) {
				const data = typeof message === "string" ? message : message.toString();
				handleSessionStreamMessage(ws, data, state.runner);
			},
			close(ws: ServerWebSocket<{ sessionId: string }>) {
				handleSessionStreamClose(ws, state.runner);
			},
		},
	});
}

// ── Server runner ────────────────────────────────────────

export async function runWebServer(options?: {
	host?: string;
	port?: number;
	openBrowser?: boolean;
	token?: string;
	allowedOrigins?: string;
	enforceOrigin?: boolean;
	restrictSensitiveApis?: boolean;
	maxPublicPathDepth?: number;
	lanOnly?: boolean;
}): Promise<void> {
	const host = options?.host ?? "127.0.0.1";
	const port = options?.port ?? DEFAULT_PORT;
	const openBrowser = options?.openBrowser ?? true;

	const actualPort = await findAvailablePort(host, port);
	if (actualPort !== port) {
		console.log(`\nPort ${port} is in use, using port ${actualPort} instead`);
	}

	const publicMode = !isLocalHost(host);

	// Auth configuration
	const token =
		options?.token ??
		process.env[ENV_SESSION_TOKEN] ??
		(publicMode ? randomUUID() : null);

	const allowedOriginsRaw =
		options?.allowedOrigins ?? process.env[ENV_ALLOWED_ORIGINS];

	const enforceOrigin =
		options?.enforceOrigin ??
		(process.env[ENV_ENFORCE_ORIGIN] === "true" || publicMode);

	const lanOnly =
		options?.lanOnly ?? (process.env[ENV_LAN_ONLY] === "true" || false);

	const restrictSensitiveApis =
		options?.restrictSensitiveApis ??
		(process.env[ENV_RESTRICT_SENSITIVE_APIS] === "true" || publicMode);

	const maxPublicPathDepth =
		options?.maxPublicPathDepth ??
		Number.parseInt(process.env[ENV_MAX_PUBLIC_PATH_DEPTH] ?? "6", 10);

	// Create runner
	const runner = new KimiCLIRunner();
	await runner.start();

	const state: WebAppState = {
		runner,
		auth: {
			token,
			allowedOrigins: normalizeAllowedOrigins(allowedOriginsRaw),
			enforceOrigin,
			lanOnly,
		},
		restrictSensitiveApis,
		restrictOpenIn: publicMode,
		maxPublicPathDepth,
	};

	// Build display hosts
	const displayHosts: Array<{ label: string; host: string }> = [];
	if (host === "0.0.0.0") {
		displayHosts.push({ label: "Local", host: "localhost" });
		for (const addr of getNetworkAddresses()) {
			displayHosts.push({ label: "Network", host: addr });
		}
	} else {
		const label = isLocalHost(host) ? "Local" : "Network";
		displayHosts.push({ label, host });
	}

	const browserHost = host === "0.0.0.0" ? "localhost" : host;
	const browserUrl = formatUrl(browserHost, actualPort);

	const bannerLines: string[] = [
		"<center>\u2588\u2588\u2557  \u2588\u2588\u2557\u2588\u2588\u2557\u2588\u2588\u2588\u2557   \u2588\u2588\u2588\u2557\u2588\u2588\u2557    \u2588\u2588\u2557   \u2588\u2588\u2557\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557",
		"<center>\u2588\u2588\u2551 \u2588\u2588\u2554\u255d\u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2551    \u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d",
		"<center>\u2588\u2588\u2588\u2588\u2588\u2554\u255d \u2588\u2588\u2551\u2588\u2588\u2554\u2588\u2588\u2588\u2588\u2554\u2588\u2588\u2551\u2588\u2588\u2551    \u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557",
		"<center>\u2588\u2588\u2554\u2550\u2588\u2588\u2557 \u2588\u2588\u2551\u2588\u2588\u2551\u255a\u2588\u2588\u2554\u255d\u2588\u2588\u2551\u2588\u2588\u2551    \u255a\u2588\u2588\u2557 \u2588\u2588\u2554\u255d\u2588\u2588\u2551\u255a\u2550\u2550\u2550\u2550\u2588\u2588\u2551",
		"<center>\u2588\u2588\u2551  \u2588\u2588\u2557\u2588\u2588\u2551\u2588\u2588\u2551 \u255a\u2550\u255d \u2588\u2588\u2551\u2588\u2588\u2551     \u255a\u2588\u2588\u2588\u2588\u2554\u255d \u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551",
		"<center>\u255a\u2550\u255d  \u255a\u2550\u255d\u255a\u2550\u255d\u255a\u2550\u255d     \u255a\u2550\u255d\u255a\u2550\u255d      \u255a\u2550\u2550\u2550\u255d  \u255a\u2550\u255d\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u255d",
		"",
		"<center>WEB SERVER",
		"",
		"<hr>",
		"",
	];

	for (const dh of displayHosts) {
		bannerLines.push(
			`<nowrap>  \u279c  ${dh.label.padEnd(8)} ${formatUrl(dh.host, actualPort)}`,
		);
	}

	bannerLines.push("");

	if (token) {
		bannerLines.push(`<nowrap>  \u279c  Token    ${token}`);
		bannerLines.push("");
	}

	bannerLines.push("<hr>");
	bannerLines.push("");

	if (publicMode) {
		bannerLines.push(
			"<nowrap>  \u26a0\ufe0f  Public mode — security features enabled:",
		);
		if (token) {
			bannerLines.push(
				"<nowrap>     \u2022 Bearer token authentication required",
			);
		}
		if (enforceOrigin) {
			bannerLines.push("<nowrap>     \u2022 Origin enforcement enabled");
		}
		if (restrictSensitiveApis) {
			bannerLines.push("<nowrap>     \u2022 Sensitive APIs restricted");
		}
		bannerLines.push("");
	} else {
		bannerLines.push("<nowrap>  Tips:");
		bannerLines.push("<nowrap>    \u2022 Use -n / --network to share on LAN");
		bannerLines.push("");
	}

	printBanner(bannerLines);

	const server = createWebServer(host, actualPort, state);

	if (openBrowser) {
		setTimeout(async () => {
			const { exec } = await import("node:child_process");
			const { platform } = process;
			const cmd =
				platform === "darwin"
					? `open "${browserUrl}"`
					: platform === "win32"
						? `start "" "${browserUrl}"`
						: `xdg-open "${browserUrl}"`;
			exec(cmd);
		}, 1500);
	}

	console.log(`\nWeb server running on ${host}:${actualPort}`);

	// Keep alive — Bun.serve runs in the background
	process.on("SIGINT", async () => {
		console.log("\nShutting down...");
		await runner.stop();
		server.stop();
		process.exit(0);
	});

	process.on("SIGTERM", async () => {
		await runner.stop();
		server.stop();
		process.exit(0);
	});

	await new Promise(() => {
		// Intentionally never resolves — server runs until process is killed
	});
}
