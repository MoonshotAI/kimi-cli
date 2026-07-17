/**
 * Proxy environment normalization — corresponds to Python utils/proxy.py
 * Rewrites socks:// to socks5:// in proxy environment variables.
 */

const PROXY_ENV_VARS = [
	"ALL_PROXY",
	"all_proxy",
	"HTTP_PROXY",
	"http_proxy",
	"HTTPS_PROXY",
	"https_proxy",
];

const SOCKS_PREFIX = "socks://";
const SOCKS5_PREFIX = "socks5://";

/**
 * Rewrite `socks://` to `socks5://` in proxy environment variables.
 *
 * Many proxy tools (V2RayN, Clash, etc.) set `ALL_PROXY=socks://...`, but
 * HTTP clients typically only recognise `socks5://`. Since `socks://` is
 * effectively an alias for `socks5://`, this function performs a safe
 * in-place replacement so that downstream HTTP clients work correctly.
 */
export function normalizeProxyEnv(): void {
	for (const varName of PROXY_ENV_VARS) {
		const value = process.env[varName];
		if (value !== undefined && value.toLowerCase().startsWith(SOCKS_PREFIX)) {
			process.env[varName] = SOCKS5_PREFIX + value.slice(SOCKS_PREFIX.length);
		}
	}
}
