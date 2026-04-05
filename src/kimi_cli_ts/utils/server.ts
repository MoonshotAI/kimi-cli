/**
 * Server utilities — corresponds to Python utils/server.py
 * Shared utilities for server startup, port finding, and banner display.
 */

import { createServer } from "node:net";
import { hostname } from "node:os";

/**
 * Return address family hint based on whether host contains `:`.
 */
export function getAddressFamily(host: string): 4 | 6 {
	return host.includes(":") ? 6 : 4;
}

/**
 * Build `http://host:port`, bracketing IPv6 literals per RFC 2732.
 */
export function formatUrl(host: string, port: number): string {
	if (host.includes(":")) {
		return `http://[${host}]:${port}`;
	}
	return `http://${host}:${port}`;
}

/**
 * Check whether host resolves to a loopback address.
 */
export function isLocalHost(host: string): boolean {
	return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Find an available port starting from startPort.
 * Throws if no port is available within the range.
 */
export async function findAvailablePort(
	host: string,
	startPort: number,
	maxAttempts = 10,
): Promise<number> {
	if (maxAttempts <= 0) throw new Error("maxAttempts must be positive");
	if (startPort < 1 || startPort > 65535)
		throw new Error("startPort must be between 1 and 65535");

	for (let offset = 0; offset < maxAttempts; offset++) {
		const port = startPort + offset;
		const available = await isPortAvailable(host, port);
		if (available) return port;
	}

	throw new Error(
		`Cannot find available port in range ${startPort}-${startPort + maxAttempts - 1}`,
	);
}

async function isPortAvailable(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", () => resolve(false));
		server.once("listening", () => {
			server.close(() => resolve(true));
		});
		server.listen(port, host);
	});
}

/**
 * Get non-loopback IPv4 addresses for this machine.
 */
export function getNetworkAddresses(): string[] {
	const addresses: string[] = [];
	try {
		const { networkInterfaces } = require("node:os");
		const interfaces = networkInterfaces();
		for (const name of Object.keys(interfaces)) {
			for (const info of interfaces[name] ?? []) {
				if (
					info.family === "IPv4" &&
					!info.internal &&
					!addresses.includes(info.address)
				) {
					addresses.push(info.address);
				}
			}
		}
	} catch {
		// Ignore
	}
	return addresses;
}

/**
 * Print a boxed banner with tag conventions (<center>, <nowrap>, <hr>).
 */
export function printBanner(lines: string[]): void {
	const processed: string[] = [];
	for (const line of lines) {
		if (line === "<hr>") {
			processed.push(line);
		} else if (!line) {
			processed.push("");
		} else if (line.startsWith("<center>") || line.startsWith("<nowrap>")) {
			processed.push(line);
		} else {
			// Simple word wrap at 78 chars
			if (line.length <= 78) {
				processed.push(line);
			} else {
				let remaining = line;
				while (remaining.length > 78) {
					const space = remaining.lastIndexOf(" ", 78);
					const cut = space > 0 ? space : 78;
					processed.push(remaining.slice(0, cut));
					remaining = remaining.slice(cut).trimStart();
				}
				if (remaining) processed.push(remaining);
			}
		}
	}

	function stripTags(s: string): string {
		return s.replace(/^<center>/, "").replace(/^<nowrap>/, "");
	}

	const contentLines = processed.filter((l) => l !== "<hr>").map(stripTags);
	const width = Math.max(60, ...contentLines.map((l) => l.length));
	const top = `+${"=".repeat(width + 2)}+`;

	console.log(top);
	for (const line of processed) {
		if (line === "<hr>") {
			console.log(`|${"-".repeat(width + 2)}|`);
		} else if (line.startsWith("<center>")) {
			const content = line.slice("<center>".length);
			const pad = width - content.length;
			const left = Math.floor(pad / 2);
			const right = pad - left;
			console.log(`| ${" ".repeat(left)}${content}${" ".repeat(right)} |`);
		} else if (line.startsWith("<nowrap>")) {
			const content = line.slice("<nowrap>".length);
			console.log(`| ${content.padEnd(width)} |`);
		} else {
			console.log(`| ${line.padEnd(width)} |`);
		}
	}
	console.log(top);
}
