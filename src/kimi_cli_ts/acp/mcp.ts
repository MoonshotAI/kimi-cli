/**
 * ACP MCP config conversion — corresponds to Python acp/mcp.py
 * Converts ACP MCP server definitions to internal MCP config format.
 */

import type { MCPServer } from "./types.ts";
import { MCPConfigError } from "../exception.ts";

/**
 * MCP config format used internally (matches fastmcp MCPConfig structure).
 */
export interface MCPConfigEntry {
	url?: string;
	transport?: string;
	headers?: Record<string, string>;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
}

export interface MCPConfig {
	mcpServers: Record<string, MCPConfigEntry>;
}

/**
 * Convert ACP MCP server definitions to internal MCPConfig format.
 * Corresponds to Python acp_mcp_servers_to_mcp_config().
 */
export function acpMcpServersToMcpConfig(mcpServers: MCPServer[]): MCPConfig {
	if (!mcpServers.length) {
		return { mcpServers: {} };
	}

	try {
		const servers: Record<string, MCPConfigEntry> = {};
		for (const server of mcpServers) {
			servers[server.name] = convertAcpMcpServer(server);
		}
		return { mcpServers: servers };
	} catch (err) {
		throw new MCPConfigError(`Invalid MCP config from ACP client: ${err}`);
	}
}

/**
 * Convert a single ACP MCP server to a dictionary representation.
 */
function convertAcpMcpServer(server: MCPServer): MCPConfigEntry {
	switch (server.type) {
		case "http":
			return {
				url: server.url,
				transport: "http",
				headers: Object.fromEntries(
					(server.headers ?? []).map((h) => [h.name, h.value]),
				),
			};
		case "sse":
			return {
				url: server.url,
				transport: "sse",
				headers: Object.fromEntries(
					(server.headers ?? []).map((h) => [h.name, h.value]),
				),
			};
		case "stdio":
			return {
				command: server.command,
				args: server.args ?? [],
				env: Object.fromEntries(
					(server.env ?? []).map((e) => [e.name, e.value]),
				),
				transport: "stdio",
			};
	}
}
