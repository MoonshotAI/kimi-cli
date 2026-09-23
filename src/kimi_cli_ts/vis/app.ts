/**
 * Kimi Agent Tracing Visualizer application.
 * Corresponds to Python vis/app.py
 *
 * Uses Bun.serve instead of FastAPI + uvicorn.
 */

import { join, resolve } from "node:path";
import { existsSync, statSync, readFileSync } from "node:fs";
import {
	findAvailablePort,
	formatUrl,
	getNetworkAddresses,
	isLocalHost,
	printBanner,
} from "../utils/server.ts";
import { handleSessionsRoute } from "./api/sessions.ts";
import { handleStatisticsRoute } from "./api/statistics.ts";
import { handleSystemRoute } from "./api/system.ts";

const STATIC_DIR = join(
	import.meta.dir,
	"..",
	"..",
	"kimi_cli",
	"vis",
	"static",
);
const GZIP_MINIMUM_SIZE = 1024;
const DEFAULT_PORT = 5495;
const ENV_RESTRICT_OPEN_IN = "KIMI_VIS_RESTRICT_OPEN_IN";

// ── Request context ───────────────────────────────────────

export interface VisAppState {
	restrictOpenIn: boolean;
}

// ── MIME helper ───────────────────────────────────────────

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

// ── CORS helper ───────────────────────────────────────────

function corsHeaders(): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "*",
		"Access-Control-Allow-Headers": "*",
		"Access-Control-Allow-Credentials": "true",
	};
}

function jsonResponse(data: unknown, status = 200): Response {
	const body = JSON.stringify(data);
	return new Response(body, {
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

// ── Open-in handler (imported from web/api) ───────────────

async function handleOpenIn(req: Request): Promise<Response> {
	const { platform } = process;
	if (platform !== "darwin" && platform !== "win32") {
		return errorResponse(
			400,
			"Open-in is only supported on macOS and Windows.",
		);
	}

	let body: { app: string; path: string };
	try {
		body = (await req.json()) as { app: string; path: string };
	} catch {
		return errorResponse(400, "Invalid JSON body");
	}

	const validApps = [
		"finder",
		"cursor",
		"vscode",
		"iterm",
		"terminal",
		"antigravity",
	];
	if (!validApps.includes(body.app)) {
		return errorResponse(400, `Unsupported app: ${body.app}`);
	}

	const resolvedPath = resolve(body.path);
	if (!existsSync(resolvedPath)) {
		return errorResponse(400, `Path does not exist: ${body.path}`);
	}

	const isFile = statSync(resolvedPath).isFile();

	try {
		if (platform === "darwin") {
			await openInMacOS(body.app, resolvedPath, isFile);
		} else {
			await openInWindows(body.app, resolvedPath, isFile);
		}
	} catch (err) {
		const detail =
			err instanceof Error ? err.message : "Failed to open application.";
		return errorResponse(500, detail);
	}

	return jsonResponse({ ok: true });
}

async function openInMacOS(
	app: string,
	path: string,
	isFile: boolean,
): Promise<void> {
	const proc = (args: string[]) =>
		Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });

	switch (app) {
		case "finder":
			if (isFile) {
				await proc(["open", "-R", path]).exited;
			} else {
				await proc(["open", path]).exited;
			}
			break;
		case "cursor":
			await proc(["open", "-a", "Cursor", path]).exited;
			break;
		case "vscode":
			try {
				await proc(["open", "-a", "Visual Studio Code", path]).exited;
			} catch {
				await proc(["open", "-a", "Code", path]).exited;
			}
			break;
		case "antigravity":
			await proc(["open", "-a", "Antigravity", path]).exited;
			break;
		case "iterm": {
			const dir = isFile ? resolve(path, "..") : path;
			const script = [
				'tell application "iTerm"',
				"  create window with default profile",
				"  tell current session of current window",
				`    write text "cd " & quoted form of "${dir}"`,
				"  end tell",
				"end tell",
			].join("\n");
			try {
				await proc(["osascript", "-e", script]).exited;
			} catch {
				await proc(["osascript", "-e", script.replace('"iTerm"', '"iTerm2"')])
					.exited;
			}
			break;
		}
		case "terminal": {
			const dir = isFile ? resolve(path, "..") : path;
			const script = `tell application "Terminal" to do script "cd " & quoted form of "${dir}"`;
			await proc(["osascript", "-e", script]).exited;
			break;
		}
	}
}

async function openInWindows(
	app: string,
	path: string,
	isFile: boolean,
): Promise<void> {
	const proc = (args: string[]) =>
		Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });

	switch (app) {
		case "finder":
			if (isFile) {
				Bun.spawn(["explorer", `/select,${path}`]);
			} else {
				Bun.spawn(["explorer", path]);
			}
			break;
		case "cursor":
			await proc(["cmd", "/c", "start", "", "cursor", path]).exited;
			break;
		case "vscode":
			await proc(["cmd", "/c", "start", "", "code", path]).exited;
			break;
		case "terminal": {
			const dir = isFile ? resolve(path, "..") : path;
			try {
				await proc(["cmd", "/c", "start", "", "wt.exe", "-d", dir]).exited;
			} catch {
				await proc([
					"cmd",
					"/c",
					"start",
					"",
					"cmd.exe",
					"/K",
					`cd /d "${dir}"`,
				]).exited;
			}
			break;
		}
		case "iterm":
		case "antigravity":
			throw new Error(`${app} is not supported on Windows.`);
	}
}

// ── Static file serving ───────────────────────────────────

function serveStaticFile(pathname: string): Response | null {
	if (!existsSync(STATIC_DIR)) return null;

	let filePath = join(STATIC_DIR, pathname);

	// Try exact path, then index.html for SPA
	if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
		filePath = join(STATIC_DIR, "index.html");
		if (!existsSync(filePath)) return null;
	}

	const content = readFileSync(filePath);
	return new Response(content, {
		headers: {
			"Content-Type": getMimeType(filePath),
			...corsHeaders(),
		},
	});
}

// ── Server factory ────────────────────────────────────────

export function createVisServer(
	host: string,
	port: number,
	state: VisAppState,
): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		hostname: host,
		port,
		async fetch(req) {
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

			// API routes
			if (pathname.startsWith("/api/vis/")) {
				const apiPath = pathname.slice("/api/vis".length);

				// Sessions routes
				if (apiPath.startsWith("/sessions")) {
					return handleSessionsRoute(req, url, apiPath);
				}

				// Statistics
				if (apiPath === "/statistics" && req.method === "GET") {
					return handleStatisticsRoute();
				}

				// System / capabilities
				if (apiPath === "/capabilities" && req.method === "GET") {
					return handleSystemRoute(state);
				}

				return errorResponse(404, "Not found");
			}

			// Open-in API (only in local mode)
			if (
				pathname === "/api/open-in" &&
				req.method === "POST" &&
				!state.restrictOpenIn
			) {
				return handleOpenIn(req);
			}

			// Static files
			const staticResponse = serveStaticFile(pathname);
			if (staticResponse) return staticResponse;

			return errorResponse(404, "Not found");
		},
	});
}

// ── Server runner ─────────────────────────────────────────

export async function runVisServer(options?: {
	host?: string;
	port?: number;
	openBrowser?: boolean;
}): Promise<void> {
	const host = options?.host ?? "127.0.0.1";
	const port = options?.port ?? DEFAULT_PORT;
	const openBrowser = options?.openBrowser ?? true;

	const actualPort = await findAvailablePort(host, port);
	if (actualPort !== port) {
		console.log(`\nPort ${port} is in use, using port ${actualPort} instead`);
	}

	const publicMode = !isLocalHost(host);

	const state: VisAppState = {
		restrictOpenIn: publicMode,
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
		"<center>AGENT TRACING VISUALIZER (Technical Preview)",
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
	bannerLines.push("<hr>");
	bannerLines.push("");

	if (!publicMode) {
		bannerLines.push("<nowrap>  Tips:");
		bannerLines.push("<nowrap>    \u2022 Use -n / --network to share on LAN");
		bannerLines.push("");
	} else {
		bannerLines.push(
			"<nowrap>  This feature is in Technical Preview and may be unstable.",
		);
		bannerLines.push("<nowrap>  Please report issues to the kimi-cli team.");
		bannerLines.push("");
	}

	printBanner(bannerLines);

	const server = createVisServer(host, actualPort, state);

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

	console.log(`\nServer running on ${host}:${actualPort}`);

	// Keep alive — Bun.serve runs in the background, we just need to not exit
	await new Promise(() => {
		// Intentionally never resolves — server runs until process is killed
	});
}
