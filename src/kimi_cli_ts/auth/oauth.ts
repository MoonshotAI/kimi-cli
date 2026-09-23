/**
 * OAuth module — corresponds to Python auth/oauth.py
 * Device-code OAuth flow, token storage & refresh for Kimi Code.
 */

import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname, platform, arch, release } from "node:os";
import { getShareDir, type Config, saveConfig } from "../config.ts";
import type { OAuthRef } from "../config.ts";
import { getVersion } from "../constant.ts";
import {
	KIMI_CODE_PLATFORM_ID,
	getPlatformById,
	listModels,
	managedProviderKey,
	managedModelKey,
	deriveModelCapabilities,
	type ModelInfo,
} from "./platforms.ts";
import { logger } from "../utils/logging.ts";

// ── Constants ───────────────────────────────────────────

const KIMI_CODE_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
export const KIMI_CODE_OAUTH_KEY = "oauth/kimi-code";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const KEYRING_SERVICE = "kimi-code";
export const REFRESH_INTERVAL_SECONDS = 60;
export const REFRESH_THRESHOLD_SECONDS = 300;

// ── Errors ──────────────────────────────────────────────

export class OAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OAuthError";
	}
}

export class OAuthUnauthorized extends OAuthError {
	constructor(message = "OAuth credentials rejected.") {
		super(message);
		this.name = "OAuthUnauthorized";
	}
}

export class OAuthDeviceExpired extends OAuthError {
	constructor(message = "Device authorization expired.") {
		super(message);
		this.name = "OAuthDeviceExpired";
	}
}

// ── Event / Token types ─────────────────────────────────

export type OAuthEventKind =
	| "info"
	| "error"
	| "waiting"
	| "verification_url"
	| "success";

export interface OAuthEvent {
	type: OAuthEventKind;
	message: string;
	data?: Record<string, unknown>;
}

export interface OAuthToken {
	access_token: string;
	refresh_token: string;
	expires_at: number;
	scope: string;
	token_type: string;
}

export interface DeviceAuthorization {
	user_code: string;
	device_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	expires_in: number | null;
	interval: number;
}

// ── Helpers ─────────────────────────────────────────────

function oauthHost(): string {
	return (
		process.env.KIMI_CODE_OAUTH_HOST ??
		process.env.KIMI_OAUTH_HOST ??
		DEFAULT_OAUTH_HOST
	);
}

function credentialsDir(): string {
	return join(getShareDir(), "credentials");
}

function credentialsPath(key: string): string {
	const name =
		key
			.replace(/^oauth\//, "")
			.split("/")
			.pop() ?? key;
	return join(credentialsDir(), `${name}.json`);
}

function deviceIdPath(): string {
	return join(getShareDir(), "device_id");
}

export async function getDeviceId(): Promise<string> {
	const path = deviceIdPath();
	const file = Bun.file(path);
	if (await file.exists()) {
		return (await file.text()).trim();
	}
	const deviceId = randomUUID().replace(/-/g, "");
	await Bun.$`mkdir -p ${getShareDir()}`.quiet();
	await Bun.write(path, deviceId);
	return deviceId;
}

function deviceModel(): string {
	const sys = platform();
	const a = arch();
	if (sys === "darwin") return `macOS ${a}`;
	if (sys === "win32") return `Windows ${a}`;
	if (sys === "linux") return `Linux ${a}`;
	return `${sys} ${a}`;
}

export async function commonHeaders(): Promise<Record<string, string>> {
	return {
		"X-Msh-Platform": "kimi_cli",
		"X-Msh-Version": getVersion(),
		"X-Msh-Device-Name": hostname(),
		"X-Msh-Device-Model": deviceModel(),
		"X-Msh-Os-Version": release(),
		"X-Msh-Device-Id": await getDeviceId(),
	};
}

// ── Token persistence (file-based) ─────────────────────

export async function loadTokens(ref: OAuthRef): Promise<OAuthToken | null> {
	const path = credentialsPath(ref.key);
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	try {
		return (await file.json()) as OAuthToken;
	} catch {
		return null;
	}
}

export async function saveTokens(
	ref: OAuthRef,
	token: OAuthToken,
): Promise<OAuthRef> {
	const path = credentialsPath(ref.key);
	await Bun.$`mkdir -p ${credentialsDir()}`.quiet();
	await Bun.write(path, JSON.stringify(token));
	return { storage: "file", key: ref.key };
}

export async function deleteTokens(ref: OAuthRef): Promise<void> {
	const path = credentialsPath(ref.key);
	const file = Bun.file(path);
	if (await file.exists()) {
		await Bun.$`rm -f ${path}`.quiet();
	}
}

// ── Device authorization flow ───────────────────────────

export async function requestDeviceAuthorization(): Promise<DeviceAuthorization> {
	const host = oauthHost().replace(/\/+$/, "");
	const headers = await commonHeaders();
	const res = await fetch(`${host}/api/oauth/device_authorization`, {
		method: "POST",
		headers: {
			...headers,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ client_id: KIMI_CODE_CLIENT_ID }),
	});
	const data = (await res.json()) as Record<string, unknown>;
	if (res.status !== 200)
		throw new OAuthError(
			`Device authorization failed: ${JSON.stringify(data)}`,
		);
	return {
		user_code: String(data.user_code),
		device_code: String(data.device_code),
		verification_uri: String(data.verification_uri ?? ""),
		verification_uri_complete: String(data.verification_uri_complete),
		expires_in: data.expires_in ? Number(data.expires_in) : null,
		interval: Number(data.interval ?? 5),
	};
}

/** Poll the token endpoint once. Corresponds to Python _request_device_token. */
async function requestDeviceToken(
	auth: DeviceAuthorization,
): Promise<{ status: number; data: Record<string, unknown> }> {
	const host = oauthHost().replace(/\/+$/, "");
	const headers = await commonHeaders();
	try {
		const res = await fetch(`${host}/api/oauth/token`, {
			method: "POST",
			headers: {
				...headers,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				client_id: KIMI_CODE_CLIENT_ID,
				device_code: auth.device_code,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});
		const data = (await res.json()) as Record<string, unknown>;
		if (res.status >= 500)
			throw new OAuthError(`Token polling server error: ${res.status}.`);
		return { status: res.status, data };
	} catch (err) {
		if (err instanceof OAuthError) throw err;
		throw new OAuthError("Token polling request failed.");
	}
}

export async function refreshToken(
	refreshTokenValue: string,
): Promise<OAuthToken> {
	const host = oauthHost().replace(/\/+$/, "");
	const headers = await commonHeaders();
	const res = await fetch(`${host}/api/oauth/token`, {
		method: "POST",
		headers: {
			...headers,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: KIMI_CODE_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: refreshTokenValue,
		}),
	});
	const data = (await res.json()) as Record<string, unknown>;
	if (res.status === 401 || res.status === 403) {
		throw new OAuthUnauthorized(
			(data.error_description as string) ?? "Token refresh unauthorized.",
		);
	}
	if (res.status !== 200) {
		throw new OAuthError(
			(data.error_description as string) ?? "Token refresh failed.",
		);
	}
	return {
		access_token: String(data.access_token),
		refresh_token: String(data.refresh_token),
		expires_at: Date.now() / 1000 + Number(data.expires_in),
		scope: String(data.scope),
		token_type: String(data.token_type),
	};
}

// ── Kimi Code login/logout (async generator) ────────────

function selectDefaultModelAndThinking(
	models: ModelInfo[],
): { model: ModelInfo; thinking: boolean } | null {
	if (!models.length) return null;
	const model = models[0]!;
	const caps = deriveModelCapabilities(model);
	const thinking = caps.has("thinking") || caps.has("always_thinking");
	return { model, thinking };
}

function applyKimiCodeConfig(
	config: Config,
	opts: {
		models: ModelInfo[];
		selectedModel: ModelInfo;
		thinking: boolean;
		oauthRef: OAuthRef;
	},
): void {
	const plat = getPlatformById(KIMI_CODE_PLATFORM_ID);
	if (!plat) throw new OAuthError("Kimi Code platform not found.");

	const providerKey = managedProviderKey(plat.id);
	config.providers[providerKey] = {
		type: "kimi",
		base_url: plat.baseUrl,
		api_key: "",
		oauth: opts.oauthRef,
	};

	// Remove old models for this provider
	for (const [key, model] of Object.entries(config.models)) {
		if (model.provider === providerKey) delete config.models[key];
	}

	// Add fresh models
	for (const modelInfo of opts.models) {
		const caps = deriveModelCapabilities(modelInfo);
		config.models[managedModelKey(plat.id, modelInfo.id)] = {
			provider: providerKey,
			model: modelInfo.id,
			max_context_size: modelInfo.contextLength,
			capabilities: caps.size > 0 ? ([...caps] as any) : undefined,
		};
	}

	config.default_model = managedModelKey(plat.id, opts.selectedModel.id);
	config.default_thinking = opts.thinking;

	if (plat.searchUrl) {
		config.services = config.services ?? {};
		(config.services as any).moonshot_search = {
			base_url: plat.searchUrl,
			api_key: "",
			oauth: opts.oauthRef,
		};
	}
	if (plat.fetchUrl) {
		config.services = config.services ?? {};
		(config.services as any).moonshot_fetch = {
			base_url: plat.fetchUrl,
			api_key: "",
			oauth: opts.oauthRef,
		};
	}
}

/**
 * Run the Kimi Code OAuth device-code login flow.
 * Yields OAuthEvent objects for UI display.
 * Corresponds to Python login_kimi_code().
 */
export async function* loginKimiCode(
	config: Config,
	opts: { openBrowser?: boolean } = {},
): AsyncGenerator<OAuthEvent> {
	const plat = getPlatformById(KIMI_CODE_PLATFORM_ID);
	if (!plat) {
		yield { type: "error", message: "Kimi Code platform is unavailable." };
		return;
	}

	let token: OAuthToken | null = null;

	// Retry loop — device codes can expire
	while (true) {
		let auth: DeviceAuthorization;
		try {
			auth = await requestDeviceAuthorization();
		} catch (err) {
			yield { type: "error", message: `Login failed: ${err}` };
			return;
		}

		yield {
			type: "info",
			message: "Please visit the following URL to finish authorization.",
		};
		yield {
			type: "verification_url",
			message: `Verification URL: ${auth.verification_uri_complete}`,
			data: {
				verification_url: auth.verification_uri_complete,
				user_code: auth.user_code,
			},
		};

		if (opts.openBrowser !== false) {
			try {
				// Use Bun.spawn to open URL in default browser
				const proc = Bun.spawn(
					process.platform === "darwin"
						? ["open", auth.verification_uri_complete]
						: process.platform === "win32"
							? ["cmd", "/c", "start", auth.verification_uri_complete]
							: ["xdg-open", auth.verification_uri_complete],
					{ stdout: "ignore", stderr: "ignore" },
				);
				await proc.exited;
			} catch {
				// Ignore browser open failures
			}
		}

		let interval = Math.max(auth.interval, 1);
		let printedWait = false;

		try {
			while (true) {
				const { status, data } = await requestDeviceToken(auth);
				if (status === 200 && data.access_token) {
					token = {
						access_token: String(data.access_token),
						refresh_token: String(data.refresh_token),
						expires_at: Date.now() / 1000 + Number(data.expires_in),
						scope: String(data.scope ?? ""),
						token_type: String(data.token_type ?? "bearer"),
					};
					break;
				}
				const errorCode = String(data.error ?? "unknown_error");
				if (errorCode === "expired_token") throw new OAuthDeviceExpired();
				if (!printedWait) {
					const desc = String(data.error_description ?? "");
					yield {
						type: "waiting",
						message: `Waiting for user authorization...${desc ? ": " + desc.trim() : ""}`,
						data: { error: errorCode, error_description: desc },
					};
					printedWait = true;
				}
				await new Promise((r) => setTimeout(r, interval * 1000));
			}
		} catch (err) {
			if (err instanceof OAuthDeviceExpired) {
				yield {
					type: "info",
					message: "Device code expired, restarting login...",
				};
				continue; // Retry outer loop
			}
			yield { type: "error", message: `Login failed: ${err}` };
			return;
		}
		break; // Got token, exit retry loop
	}

	if (!token) return;

	// Save token
	const oauthRef: OAuthRef = { storage: "file", key: KIMI_CODE_OAUTH_KEY };
	await saveTokens(oauthRef, token);

	// Fetch models
	let models: ModelInfo[];
	try {
		models = await listModels(plat, token.access_token);
	} catch (err) {
		logger.error(`Failed to get models: ${err}`);
		yield { type: "error", message: `Failed to get models: ${err}` };
		return;
	}

	if (!models.length) {
		yield {
			type: "error",
			message: "No models available for the selected platform.",
		};
		return;
	}

	const selection = selectDefaultModelAndThinking(models);
	if (!selection) return;

	applyKimiCodeConfig(config, {
		models,
		selectedModel: selection.model,
		thinking: selection.thinking,
		oauthRef,
	});
	await saveConfig(config);
	yield { type: "success", message: "Logged in successfully." };
}

/**
 * Logout from Kimi Code — delete tokens and clean up config.
 * Corresponds to Python logout_kimi_code().
 */
export async function* logoutKimiCode(
	config: Config,
): AsyncGenerator<OAuthEvent> {
	// Delete stored tokens (both keyring and file)
	await deleteTokens({ storage: "keyring", key: KIMI_CODE_OAUTH_KEY });
	await deleteTokens({ storage: "file", key: KIMI_CODE_OAUTH_KEY });

	const providerKey = managedProviderKey(KIMI_CODE_PLATFORM_ID);
	if (config.providers[providerKey]) {
		delete config.providers[providerKey];
	}

	let removedDefault = false;
	for (const [key, model] of Object.entries(config.models)) {
		if (model.provider !== providerKey) continue;
		delete config.models[key];
		if (config.default_model === key) removedDefault = true;
	}
	if (removedDefault) config.default_model = "";

	if (config.services) {
		(config.services as any).moonshot_search = undefined;
		(config.services as any).moonshot_fetch = undefined;
	}

	await saveConfig(config);
	yield { type: "success", message: "Logged out successfully." };
}

// ── OAuthManager ────────────────────────────────────────

export class OAuthManager {
	private config: {
		providers: Record<string, { api_key: string; oauth?: OAuthRef }>;
	};
	private accessTokens = new Map<string, string>();

	constructor(config: {
		providers: Record<string, { api_key: string; oauth?: OAuthRef }>;
	}) {
		this.config = config;
	}

	async initialize(): Promise<void> {
		for (const provider of Object.values(this.config.providers)) {
			if (provider.oauth) {
				const token = await loadTokens(provider.oauth);
				if (token)
					this.accessTokens.set(provider.oauth.key, token.access_token);
			}
		}
	}

	async resolveApiKey(apiKey: string, oauth?: OAuthRef): Promise<string> {
		if (oauth) {
			const cached = this.accessTokens.get(oauth.key);
			if (cached) return cached;
			const persisted = await loadTokens(oauth);
			if (persisted) {
				this.accessTokens.set(oauth.key, persisted.access_token);
				return persisted.access_token;
			}
			logger.warn(
				`OAuth ref present (key=${oauth.key}) but no access token; falling back to api_key`,
			);
		}
		return apiKey;
	}

	async ensureFresh(): Promise<void> {
		for (const provider of Object.values(this.config.providers)) {
			if (!provider.oauth) continue;
			const token = await loadTokens(provider.oauth);
			if (!token || !token.refresh_token) continue;

			this.accessTokens.set(provider.oauth.key, token.access_token);

			const now = Date.now() / 1000;
			if (
				token.expires_at &&
				token.expires_at > now &&
				token.expires_at - now >= REFRESH_THRESHOLD_SECONDS
			) {
				continue;
			}
			try {
				const refreshed = await refreshToken(token.refresh_token);
				await saveTokens(provider.oauth, refreshed);
				this.accessTokens.set(provider.oauth.key, refreshed.access_token);
			} catch (err) {
				if (err instanceof OAuthUnauthorized) {
					this.accessTokens.delete(provider.oauth.key);
					await deleteTokens(provider.oauth);
				} else {
					logger.warn("Failed to refresh OAuth token", err);
				}
			}
		}
	}

	/**
	 * Background refresh loop — corresponds to Python OAuthManager.refreshing().
	 * Periodically calls ensureFresh() until the returned abort function is called.
	 * Returns an AbortController; call abort() to stop the background loop.
	 */
	refreshing(): AbortController {
		const controller = new AbortController();
		const signal = controller.signal;

		const run = async () => {
			// Initial ensure fresh
			try {
				await this.ensureFresh();
			} catch (err) {
				logger.warn(`Failed initial OAuth token refresh: ${err}`);
			}

			while (!signal.aborted) {
				try {
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(resolve, REFRESH_INTERVAL_SECONDS * 1000);
						signal.addEventListener(
							"abort",
							() => {
								clearTimeout(timer);
								reject(new Error("aborted"));
							},
							{ once: true },
						);
					});
				} catch {
					break; // Aborted
				}

				try {
					await this.ensureFresh();
				} catch (err) {
					logger.warn(`Failed to refresh OAuth token in background: ${err}`);
				}
			}
		};

		// Fire-and-forget background loop
		run().catch(() => {});

		return controller;
	}
}
