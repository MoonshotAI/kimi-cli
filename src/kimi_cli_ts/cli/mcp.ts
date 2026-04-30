/**
 * MCP server management CLI — corresponds to Python cli/mcp.py
 */

import { Command } from "commander";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getShareDir } from "../share.ts";

function getGlobalMcpConfigFile(): string {
	return join(getShareDir(), "mcp.json");
}

function loadMcpConfig(): Record<string, unknown> {
	const mcpFile = getGlobalMcpConfigFile();
	if (!existsSync(mcpFile)) return { mcpServers: {} };
	try {
		return JSON.parse(readFileSync(mcpFile, "utf-8")) as Record<
			string,
			unknown
		>;
	} catch (err) {
		console.error(`Invalid JSON in MCP config file '${mcpFile}': ${err}`);
		process.exit(1);
	}
}

function saveMcpConfig(config: Record<string, unknown>): void {
	const mcpFile = getGlobalMcpConfigFile();
	mkdirSync(dirname(mcpFile), { recursive: true });
	writeFileSync(mcpFile, JSON.stringify(config, null, 2), "utf-8");
}

function getMcpServer(name: string): Record<string, unknown> {
	const config = loadMcpConfig();
	const servers = (config.mcpServers ?? {}) as Record<
		string,
		Record<string, unknown>
	>;
	if (!(name in servers)) {
		console.error(`MCP server '${name}' not found.`);
		process.exit(1);
	}
	return servers[name]!;
}

function parseKeyValuePairs(
	items: string[],
	optionName: string,
	separator = "=",
): Record<string, string> {
	const parsed: Record<string, string> = {};
	for (const item of items) {
		const idx = item.indexOf(separator);
		if (idx === -1) {
			console.error(
				`Invalid ${optionName} format: ${item} (expected KEY${separator}VALUE).`,
			);
			process.exit(1);
		}
		const key =
			separator === ":" ? item.slice(0, idx).trim() : item.slice(0, idx);
		const value =
			separator === ":" ? item.slice(idx + 1).trim() : item.slice(idx + 1);
		if (!key) {
			console.error(`Invalid ${optionName} format: ${item} (empty key).`);
			process.exit(1);
		}
		parsed[key] = value;
	}
	return parsed;
}

function collect(val: string, prev: string[]): string[] {
	return [...prev, val];
}

export const mcpCommand = new Command("mcp").description(
	"Manage MCP server configurations.",
);

mcpCommand
	.command("add")
	.description("Add an MCP server.")
	.argument("<name>", "Name of the MCP server to add")
	.argument(
		"[args...]",
		"For http: server URL. For stdio: command to run (prefix with `--`).",
	)
	.option("-t, --transport <type>", "Transport type (stdio or http)", "stdio")
	.option(
		"-e, --env <value>",
		"Environment variables in KEY=VALUE format",
		collect,
		[],
	)
	.option(
		"-H, --header <value>",
		"HTTP headers in KEY:VALUE format",
		collect,
		[],
	)
	.option("-a, --auth <type>", "Authorization type (e.g., 'oauth')")
	.action(
		(
			name: string,
			serverArgs: string[],
			options: {
				transport: string;
				env: string[];
				header: string[];
				auth?: string;
			},
		) => {
			const config = loadMcpConfig();
			const { transport, env, header, auth } = options;

			let serverConfig: Record<string, unknown>;

			if (transport === "stdio") {
				if (serverArgs.length === 0) {
					console.error("For stdio transport, provide the command after `--`.");
					process.exit(1);
				}
				if (header.length > 0) {
					console.error("--header is only valid for http transport.");
					process.exit(1);
				}
				if (auth) {
					console.error("--auth is only valid for http transport.");
					process.exit(1);
				}
				const [command, ...cmdArgs] = serverArgs;
				serverConfig = { command, args: cmdArgs };
				if (env.length > 0) {
					serverConfig.env = parseKeyValuePairs(env, "env");
				}
			} else if (transport === "http") {
				if (env.length > 0) {
					console.error("--env is only supported for stdio transport.");
					process.exit(1);
				}
				if (serverArgs.length === 0) {
					console.error("URL is required for http transport.");
					process.exit(1);
				}
				if (serverArgs.length > 1) {
					console.error("Supply a single URL for http transport.");
					process.exit(1);
				}
				serverConfig = { url: serverArgs[0], transport: "http" };
				if (header.length > 0) {
					serverConfig.headers = parseKeyValuePairs(header, "header", ":");
				}
				if (auth) serverConfig.auth = auth;
			} else {
				console.error(`Unsupported transport: ${transport}`);
				process.exit(1);
			}

			const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
			servers[name] = serverConfig;
			config.mcpServers = servers;
			saveMcpConfig(config);
			console.log(`Added MCP server '${name}' to ${getGlobalMcpConfigFile()}.`);
		},
	);

mcpCommand
	.command("remove")
	.description("Remove an MCP server.")
	.argument("<name>", "Name of the MCP server to remove")
	.action((name: string) => {
		getMcpServer(name); // Validates it exists
		const config = loadMcpConfig();
		const servers = config.mcpServers as Record<string, unknown>;
		delete servers[name];
		saveMcpConfig(config);
		console.log(
			`Removed MCP server '${name}' from ${getGlobalMcpConfigFile()}.`,
		);
	});

mcpCommand
	.command("list")
	.description("List all MCP servers.")
	.action(() => {
		const configFile = getGlobalMcpConfigFile();
		const config = loadMcpConfig();
		const servers = (config.mcpServers ?? {}) as Record<
			string,
			Record<string, unknown>
		>;

		console.log(`MCP config file: ${configFile}`);
		if (Object.keys(servers).length === 0) {
			console.log("No MCP servers configured.");
			return;
		}

		for (const [name, server] of Object.entries(servers)) {
			let line: string;
			if ("command" in server) {
				const cmdArgs = ((server.args as string[]) ?? []).join(" ");
				line = `${name} (stdio): ${server.command} ${cmdArgs}`.trimEnd();
			} else if ("url" in server) {
				let transport = (server.transport as string) ?? "http";
				if (transport === "streamable-http") transport = "http";
				line = `${name} (${transport}): ${server.url}`;
			} else {
				line = `${name}: ${JSON.stringify(server)}`;
			}
			console.log(`  ${line}`);
		}
	});

mcpCommand
	.command("test")
	.description("Test connection to an MCP server and list available tools.")
	.argument("<name>", "Name of the MCP server to test")
	.action(async (name: string) => {
		const server = getMcpServer(name);

		try {
			const { Client } = await import(
				"@modelcontextprotocol/sdk/client/index.js"
			);
			const { StdioClientTransport } = await import(
				"@modelcontextprotocol/sdk/client/stdio.js"
			);

			let transport: InstanceType<typeof StdioClientTransport>;

			if ("command" in server && server.command) {
				transport = new StdioClientTransport({
					command: server.command as string,
					args: (server.args as string[]) ?? [],
					env: (server.env as Record<string, string>) ?? undefined,
				});
			} else if ("url" in server && server.url) {
				console.error("HTTP MCP transport is not yet supported for testing.");
				process.exit(1);
			} else {
				console.error(`Unknown server configuration for '${name}'.`);
				process.exit(1);
			}

			const client = new Client({
				name: `kimi-cli-test-${name}`,
				version: "2.0.0",
			});

			console.log(`Connecting to MCP server '${name}'...`);
			await client.connect(transport);

			const { tools } = await client.listTools();
			console.log(`\nConnected! ${tools.length} tool(s) available:\n`);

			for (const tool of tools) {
				const desc = tool.description
					? `: ${tool.description}`
					: "";
				console.log(`  - ${tool.name}${desc}`);
			}

			await client.close();
		} catch (err) {
			console.error(`Failed to connect to MCP server '${name}': ${err}`);
			process.exit(1);
		}
	});

mcpCommand
	.command("auth")
	.description("Authorize with an OAuth-enabled MCP server.")
	.argument("<name>", "Name of the MCP server to authorize")
	.action((name: string) => {
		const server = getMcpServer(name);
		if (server.auth !== "oauth") {
			console.error(
				`MCP server '${name}' does not use OAuth. Add with --auth oauth.`,
			);
			process.exit(1);
		}
		// TODO: Implement OAuth flow when fastmcp TS equivalent is available
		console.log(
			`OAuth authorization for MCP server '${name}' is not yet implemented.`,
		);
	});

mcpCommand
	.command("reset-auth")
	.description("Reset OAuth authorization for an MCP server.")
	.argument("<name>", "Name of the MCP server to reset authorization")
	.action((name: string) => {
		getMcpServer(name);
		// TODO: Implement OAuth token clearing
		console.log(`OAuth token reset for '${name}' is not yet implemented.`);
	});
