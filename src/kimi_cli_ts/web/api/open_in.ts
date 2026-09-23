/**
 * Web API open-in — corresponds to Python web/api/open_in.py
 * Open files/folders in local applications (macOS, Windows).
 * Nearly identical to vis/app.ts handleOpenIn, but as a standalone handler.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

// ── Types ────────────────────────────────────────────────

interface OpenInRequest {
	app: string;
	path: string;
}

const VALID_APPS = [
	"finder",
	"cursor",
	"vscode",
	"iterm",
	"terminal",
	"antigravity",
];

// ── Helpers ──────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Access-Control-Allow-Origin": "*",
		},
	});
}

// ── Platform-specific openers ────────────────────────────

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

// ── Route handler ────────────────────────────────────────

export async function handleOpenInRoute(req: Request): Promise<Response> {
	const { platform } = process;
	if (platform !== "darwin" && platform !== "win32") {
		return jsonResponse(
			{ detail: "Open-in is only supported on macOS and Windows." },
			400,
		);
	}

	let body: OpenInRequest;
	try {
		body = (await req.json()) as OpenInRequest;
	} catch {
		return jsonResponse({ detail: "Invalid JSON body" }, 400);
	}

	if (!VALID_APPS.includes(body.app)) {
		return jsonResponse({ detail: `Unsupported app: ${body.app}` }, 400);
	}

	const resolvedPath = resolve(body.path);
	if (!existsSync(resolvedPath)) {
		return jsonResponse({ detail: `Path does not exist: ${body.path}` }, 400);
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
		return jsonResponse({ detail }, 500);
	}

	return jsonResponse({ ok: true });
}
