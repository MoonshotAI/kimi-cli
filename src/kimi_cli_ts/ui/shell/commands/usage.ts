import { loadTokens } from "../../../auth/oauth.ts";
import type { Config } from "../../../config.ts";
import type { UsageRow } from "../UsagePanel.tsx";

/**
 * Structured result from fetching usage data.
 */
export interface UsageResult {
	summary: UsageRow | null;
	limits: UsageRow[];
	error?: string;
}

/**
 * Fetch API usage data and return structured results for rendering.
 * Mirrors Python's _parse_usage_payload behavior.
 */
export async function fetchAndParseUsage(
	config: Config,
	modelKey: string | undefined,
): Promise<UsageResult> {
	if (!modelKey || !config.models[modelKey]) {
		return {
			summary: null,
			limits: [],
			error: "No model selected. Run /login first.",
		};
	}

	const modelCfg = config.models[modelKey]!;
	const providerCfg = config.providers[modelCfg.provider];
	if (!providerCfg) {
		return { summary: null, limits: [], error: "Provider not found." };
	}

	// Resolve API key (try OAuth token first)
	let apiKey = providerCfg.api_key;
	if (providerCfg.oauth) {
		const token = await loadTokens(providerCfg.oauth);
		if (token) apiKey = token.access_token;
	}

	const baseUrl = providerCfg.base_url.replace(/\/+$/, "");
	const usageUrl = `${baseUrl}/usages`;

	try {
		const res = await fetch(usageUrl, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});

		if (!res.ok) {
			let errorMsg = `Failed to fetch usage (HTTP ${res.status}).`;
			if (res.status === 401)
				errorMsg = "Authorization failed. Please check your API key.";
			else if (res.status === 404) errorMsg = "Usage endpoint not available.";
			return { summary: null, limits: [], error: errorMsg };
		}

		const data = (await res.json()) as Record<string, any>;
		return parseUsagePayload(data);
	} catch (err) {
		const errorMsg = `Failed to fetch usage: ${err instanceof Error ? err.message : err}`;
		return { summary: null, limits: [], error: errorMsg };
	}
}

/**
 * Parse usage API payload into structured UsageRow objects.
 * Mirrors Python's _parse_usage_payload + _to_usage_row logic.
 */
function parseUsagePayload(payload: Record<string, any>): UsageResult {
	let summary: UsageRow | null = null;
	const limits: UsageRow[] = [];

	const usage = payload.usage;
	if (usage && typeof usage === "object") {
		summary = toUsageRow(usage as Record<string, any>, "Weekly limit");
	}

	const rawLimits = payload.limits;
	if (Array.isArray(rawLimits)) {
		for (let idx = 0; idx < rawLimits.length; idx++) {
			const item = rawLimits[idx];
			if (!item || typeof item !== "object") continue;
			const itemMap = item as Record<string, any>;
			const detail =
				itemMap.detail && typeof itemMap.detail === "object"
					? (itemMap.detail as Record<string, any>)
					: itemMap;
			const window =
				itemMap.window && typeof itemMap.window === "object"
					? (itemMap.window as Record<string, any>)
					: {};
			const label = limitLabel(itemMap, detail, window, idx);
			const row = toUsageRow(detail, label);
			if (row) limits.push(row);
		}
	}

	return { summary, limits };
}

function toUsageRow(
	data: Record<string, any>,
	defaultLabel: string,
): UsageRow | null {
	const limit = toInt(data.limit);
	let used = toInt(data.used);
	if (used == null) {
		const remaining = toInt(data.remaining);
		if (remaining != null && limit != null) {
			used = limit - remaining;
		}
	}
	if (used == null && limit == null) return null;
	return {
		label: String(data.name || data.title || defaultLabel),
		used: used || 0,
		limit: limit || 0,
		resetHint: resetHint(data),
	};
}

function limitLabel(
	item: Record<string, any>,
	detail: Record<string, any>,
	window: Record<string, any>,
	idx: number,
): string {
	for (const key of ["name", "title", "scope"]) {
		const val = item[key] || detail[key];
		if (val) return String(val);
	}

	const duration = toInt(window.duration || item.duration || detail.duration);
	const timeUnit = String(
		window.timeUnit || item.timeUnit || detail.timeUnit || "",
	);

	if (duration) {
		if (timeUnit.includes("MINUTE")) {
			if (duration >= 60 && duration % 60 === 0)
				return `${duration / 60}h limit`;
			return `${duration}m limit`;
		}
		if (timeUnit.includes("HOUR")) return `${duration}h limit`;
		if (timeUnit.includes("DAY")) return `${duration}d limit`;
		return `${duration}s limit`;
	}

	return `Limit #${idx + 1}`;
}

function resetHint(data: Record<string, any>): string | null {
	for (const key of ["reset_at", "resetAt", "reset_time", "resetTime"]) {
		if (data[key]) return formatResetTime(String(data[key]));
	}

	for (const key of ["reset_in", "resetIn", "ttl", "window"]) {
		const seconds = toInt(data[key]);
		if (seconds) return `resets in ${formatDuration(seconds)}`;
	}

	return null;
}

function formatResetTime(val: string): string {
	try {
		const dt = new Date(val);
		const now = Date.now();
		const delta = dt.getTime() - now;
		if (delta <= 0) return "reset";
		return `resets in ${formatDuration(Math.floor(delta / 1000))}`;
	} catch {
		return `resets at ${val}`;
	}
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	const hours = Math.floor(seconds / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
}

function toInt(value: any): number | null {
	if (value == null) return null;
	const n = Number(value);
	return Number.isFinite(n) ? Math.floor(n) : null;
}

/**
 * Legacy: return plain text for terminal output.
 * Kept for backward compatibility.
 */
export async function handleUsage(
	config: Config,
	modelKey: string | undefined,
): Promise<string> {
	const result = await fetchAndParseUsage(config, modelKey);
	if (result.error) return result.error;

	const lines: string[] = [];
	const rows = [...(result.summary ? [result.summary] : []), ...result.limits];

	if (rows.length === 0) {
		return "No usage data available.";
	}

	lines.push("API Usage:");
	for (const row of rows) {
		const remaining = row.limit > 0 ? (row.limit - row.used) / row.limit : 0;
		const pct = (remaining * 100).toFixed(0);
		lines.push(
			`  ${row.label}: ${row.used}/${row.limit} used (${pct}% remaining)`,
		);
		if (row.resetHint) {
			lines.push(`    (${row.resetHint})`);
		}
	}

	return lines.join("\n");
}
