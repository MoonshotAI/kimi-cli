/**
 * Web auth — corresponds to Python web/auth.py
 * Authentication, origin checking, LAN-only enforcement, IP helpers.
 */

import { timingSafeEqual, createHash } from "node:crypto";

// ── Constants ────────────────────────────────────────────

const DEFAULT_ALLOWED_ORIGIN_REGEX =
	/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// ── Timing-safe compare ──────────────────────────────────

export function timingSafeCompare(a: string, b: string): boolean {
	const bufA = Buffer.from(a, "utf-8");
	const bufB = Buffer.from(b, "utf-8");
	if (bufA.length !== bufB.length) {
		// Hash both to avoid leaking length info via timing
		const hA = createHash("sha256").update(bufA).digest();
		const hB = createHash("sha256").update(bufB).digest();
		timingSafeEqual(hA, hB);
		return false;
	}
	return timingSafeEqual(bufA, bufB);
}

// ── Bearer token parsing ─────────────────────────────────

export function parseBearerToken(value: string): string | null {
	if (!value.startsWith("Bearer ")) return null;
	const token = value.slice(7).trim();
	return token || null;
}

// ── Origin checking ──────────────────────────────────────

/**
 * Parse comma-separated origins string into array.
 * Returns null if value is empty/undefined (meaning "use default localhost regex").
 */
export function normalizeAllowedOrigins(
	value: string | undefined,
): string[] | null {
	if (!value) return null;
	const origins = value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return origins.length > 0 ? origins : null;
}

/**
 * Check if an origin is allowed.
 * - allowedOrigins === null → use default localhost regex
 * - allowedOrigins === [] → reject all
 * - allowedOrigins includes "*" → allow all
 * - otherwise → exact match
 */
export function isOriginAllowed(
	origin: string | null,
	allowedOrigins: string[] | null,
): boolean {
	if (!origin) return false;

	if (allowedOrigins === null) {
		return DEFAULT_ALLOWED_ORIGIN_REGEX.test(origin);
	}

	if (allowedOrigins.length === 0) return false;
	if (allowedOrigins.includes("*")) return true;

	return allowedOrigins.includes(origin);
}

// ── Token extraction ─────────────────────────────────────

/**
 * Extract auth token from request: Authorization header, or query param (GET only).
 */
export function extractTokenFromRequest(req: Request, url: URL): string | null {
	const authHeader = req.headers.get("authorization");
	if (authHeader) {
		return parseBearerToken(authHeader);
	}

	// For GET requests, also check query param
	if (req.method === "GET") {
		const token = url.searchParams.get("token");
		if (token) return token;
	}

	return null;
}

// ── Token verification ───────────────────────────────────

export function verifyToken(
	provided: string | null,
	expected: string | null,
): boolean {
	if (!expected) return true; // No token configured = open access
	if (!provided) return false;
	return timingSafeCompare(provided, expected);
}

// ── IP helpers ───────────────────────────────────────────

/**
 * Check if an IP address is a private/local address (RFC 1918, loopback, link-local).
 */
export function isPrivateIp(ip: string): boolean {
	// IPv4 loopback
	if (ip === "127.0.0.1" || ip.startsWith("127.")) return true;
	// IPv6 loopback
	if (ip === "::1") return true;
	// RFC 1918
	if (ip.startsWith("10.")) return true;
	if (ip.startsWith("172.")) {
		const second = Number.parseInt(ip.split(".")[1]!, 10);
		if (second >= 16 && second <= 31) return true;
	}
	if (ip.startsWith("192.168.")) return true;
	// Link-local
	if (ip.startsWith("169.254.")) return true;
	// IPv6 link-local
	if (ip.toLowerCase().startsWith("fe80:")) return true;
	// IPv6 unique local (fd00::/8)
	if (ip.toLowerCase().startsWith("fd")) return true;

	return false;
}

/**
 * Get the client IP from a request, optionally trusting X-Forwarded-For.
 */
export function getClientIp(
	req: Request,
	server: { requestIP?: (req: Request) => { address: string } | null },
	trustProxy = false,
): string | null {
	if (trustProxy) {
		const xff = req.headers.get("x-forwarded-for");
		if (xff) {
			const first = xff.split(",")[0]!.trim();
			if (first) return first;
		}
	}

	if (server.requestIP) {
		const info = server.requestIP(req);
		if (info) return info.address;
	}

	return null;
}

// ── Auth check (inline middleware equivalent) ────────────

export interface AuthConfig {
	token: string | null;
	allowedOrigins: string[] | null;
	enforceOrigin: boolean;
	lanOnly: boolean;
}

/**
 * Run authentication checks for an API request.
 * Returns null if the request is allowed, or a Response to return.
 */
export function authCheck(
	req: Request,
	url: URL,
	config: AuthConfig,
	server: { requestIP?: (req: Request) => { address: string } | null },
): Response | null {
	const { pathname } = url;

	// Skip auth for non-API routes, OPTIONS, healthz
	if (!pathname.startsWith("/api/")) return null;
	if (req.method === "OPTIONS") return null;
	if (pathname === "/healthz") return null;

	// LAN-only check
	if (config.lanOnly) {
		const clientIp = getClientIp(req, server);
		if (clientIp && !isPrivateIp(clientIp)) {
			return new Response(
				JSON.stringify({ detail: "Forbidden: non-LAN client" }),
				{
					status: 403,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
	}

	// Origin check
	if (config.enforceOrigin) {
		const origin = req.headers.get("origin");
		// For requests with an Origin header, validate it
		if (origin && !isOriginAllowed(origin, config.allowedOrigins)) {
			return new Response(
				JSON.stringify({ detail: "Forbidden: origin not allowed" }),
				{
					status: 403,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
	}

	// Token check
	if (config.token) {
		const provided = extractTokenFromRequest(req, url);
		if (!verifyToken(provided, config.token)) {
			return new Response(JSON.stringify({ detail: "Unauthorized" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}
	}

	return null;
}
