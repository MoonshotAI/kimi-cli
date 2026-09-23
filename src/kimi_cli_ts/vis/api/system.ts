/**
 * Vis API for server capabilities and metadata.
 * Corresponds to Python vis/api/system.py
 */

import type { VisAppState } from "../app.ts";

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Access-Control-Allow-Origin": "*",
		},
	});
}

export function handleSystemRoute(state: VisAppState): Response {
	return jsonResponse({
		open_in_supported:
			(process.platform === "darwin" || process.platform === "win32") &&
			!state.restrictOpenIn,
	});
}
