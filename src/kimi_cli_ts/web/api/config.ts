/**
 * Web API config — corresponds to Python web/api/config.py
 * Global configuration routes (get/update model settings, raw config.toml).
 */

import { existsSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { getShareDir } from "../../config.ts";
import { join } from "node:path";
import type { KimiCLIRunner } from "../runner/process.ts";

// ── Types ────────────────────────────────────────────────

interface ConfigModel {
	name: string;
	provider_type: string;
	model: string;
	base_url?: string;
	api_key?: string;
	max_context_size?: number;
	max_output_tokens?: number;
	temperature?: number;
	top_p?: number;
	capabilities?: string[];
}

interface GlobalConfig {
	default_model: string | null;
	default_thinking: boolean;
	models: ConfigModel[];
}

interface UpdateGlobalConfigRequest {
	default_model?: string;
	default_thinking?: boolean;
}

interface UpdateGlobalConfigResponse {
	config: GlobalConfig;
	restarted_sessions: string[];
	skipped_busy_sessions: string[];
}

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

function getConfigTomlPath(): string {
	return join(getShareDir(), "config.toml");
}

function buildGlobalConfig(): GlobalConfig {
	const configPath = getConfigTomlPath();
	let defaultModel: string | null = null;
	let defaultThinking = false;
	const models: ConfigModel[] = [];

	if (existsSync(configPath)) {
		try {
			const raw = readFileSync(configPath, "utf-8");
			// Simple TOML parsing for the fields we need
			for (const line of raw.split("\n")) {
				const trimmed = line.trim();
				if (trimmed.startsWith("default_model")) {
					const match = trimmed.match(/=\s*"(.+)"/);
					if (match) defaultModel = match[1]!;
				}
				if (trimmed.startsWith("default_thinking")) {
					defaultThinking = trimmed.includes("true");
				}
			}
		} catch {
			// ignore
		}
	}

	return {
		default_model: defaultModel,
		default_thinking: defaultThinking,
		models,
	};
}

// ── Route handler ────────────────────────────────────────

export async function handleConfigRoute(
	req: Request,
	url: URL,
	apiPath: string,
	runner: KimiCLIRunner,
	restrictSensitiveApis: boolean,
): Promise<Response> {
	// GET /api/config/
	if (apiPath === "/config" && req.method === "GET") {
		return jsonResponse(buildGlobalConfig());
	}

	// PATCH /api/config/
	if (apiPath === "/config" && req.method === "PATCH") {
		if (restrictSensitiveApis) {
			return jsonResponse(
				{ detail: "Sensitive API restricted in public mode" },
				403,
			);
		}

		let body: UpdateGlobalConfigRequest;
		try {
			body = (await req.json()) as UpdateGlobalConfigRequest;
		} catch {
			return jsonResponse({ detail: "Invalid JSON body" }, 400);
		}

		// Update config.toml — simplified version
		const configPath = getConfigTomlPath();
		let content = "";
		if (existsSync(configPath)) {
			content = readFileSync(configPath, "utf-8");
		}

		if (body.default_model !== undefined) {
			if (content.includes("default_model")) {
				content = content.replace(
					/default_model\s*=\s*".+"/,
					`default_model = "${body.default_model}"`,
				);
			} else {
				content += `\ndefault_model = "${body.default_model}"\n`;
			}
		}
		if (body.default_thinking !== undefined) {
			if (content.includes("default_thinking")) {
				content = content.replace(
					/default_thinking\s*=\s*(true|false)/,
					`default_thinking = ${body.default_thinking}`,
				);
			} else {
				content += `\ndefault_thinking = ${body.default_thinking}\n`;
			}
		}

		writeFileSync(configPath, content);

		// Restart running workers
		const summary = await runner.restartRunningWorkers("config_change");

		const response: UpdateGlobalConfigResponse = {
			config: buildGlobalConfig(),
			restarted_sessions: summary.restartedSessionIds,
			skipped_busy_sessions: summary.skippedBusySessionIds,
		};

		return jsonResponse(response);
	}

	// GET /api/config/toml
	if (apiPath === "/config/toml" && req.method === "GET") {
		const configPath = getConfigTomlPath();
		let content = "";
		if (existsSync(configPath)) {
			content = readFileSync(configPath, "utf-8");
		}
		return jsonResponse({ content });
	}

	// PUT /api/config/toml
	if (apiPath === "/config/toml" && req.method === "PUT") {
		if (restrictSensitiveApis) {
			return jsonResponse(
				{ detail: "Sensitive API restricted in public mode" },
				403,
			);
		}

		let body: { content: string };
		try {
			body = (await req.json()) as { content: string };
		} catch {
			return jsonResponse({ detail: "Invalid JSON body" }, 400);
		}

		if (typeof body.content !== "string") {
			return jsonResponse({ detail: "content must be a string" }, 400);
		}

		const configPath = getConfigTomlPath();
		writeFileSync(configPath, body.content);

		return jsonResponse({ content: body.content });
	}

	return jsonResponse({ detail: "Not found" }, 404);
}
