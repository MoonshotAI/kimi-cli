/**
 * Plugin tool wrapper — corresponds to Python plugin/tool.py
 * Runs plugin-declared tools as subprocesses.
 */

import { join } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { logger } from "../utils/logging.ts";
import type { Approval } from "../soul/approval.ts";
import {
	type PluginToolSpec,
	type PluginSpec,
	PluginError,
	PLUGIN_JSON,
	parsePluginJson,
} from "./manager.ts";

export interface PluginToolResult {
	ok: boolean;
	output: string;
	brief?: string;
}

/**
 * Collect host values (api_key, base_url) for plugin injection.
 * Resolves credentials from the default provider, handling OAuth tokens
 * and static API keys.
 */
export interface PluginConfig {
	defaultModel?: string;
	models: Record<string, { provider: string }>;
	providers: Record<
		string,
		{ apiKey?: string; baseUrl: string; oauth?: unknown }
	>;
}

export interface OAuthManager {
	resolveApiKey(apiKey: string | undefined, oauth: unknown): string | undefined;
}

export function collectHostValues(
	config: PluginConfig,
	oauth: OAuthManager,
): Record<string, string> {
	const values: Record<string, string> = {};
	if (!config.defaultModel || !(config.defaultModel in config.models))
		return values;
	const model = config.models[config.defaultModel]!;
	if (!(model.provider in config.providers)) return values;
	const provider = config.providers[model.provider]!;
	const apiKey = oauth.resolveApiKey(provider.apiKey, provider.oauth);
	if (apiKey) values["api_key"] = apiKey;
	values["base_url"] = provider.baseUrl;
	return values;
}

export class PluginTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
	private _command: string[];
	private _pluginDir: string;
	private _inject: Record<string, string>;
	private _getHostValues?: () => Record<string, string>;
	private _approval?: Approval;

	constructor(opts: {
		toolSpec: PluginToolSpec;
		pluginDir: string;
		inject: Record<string, string>;
		getHostValues?: () => Record<string, string>;
		approval?: Approval;
	}) {
		this.name = opts.toolSpec.name;
		this.description = opts.toolSpec.description;
		this.parameters = opts.toolSpec.parameters || {
			type: "object",
			properties: {},
		};
		this._command = opts.toolSpec.command;
		this._pluginDir = opts.pluginDir;
		this._inject = opts.inject;
		this._getHostValues = opts.getHostValues;
		this._approval = opts.approval;
	}

	private buildEnv(): Record<string, string> {
		const env: Record<string, string> = { ...process.env } as Record<
			string,
			string
		>;
		if (Object.keys(this._inject).length > 0) {
			const hostValues = this._getHostValues?.() ?? {};
			for (const [targetKey, sourceKey] of Object.entries(this._inject)) {
				if (sourceKey in hostValues) {
					env[targetKey] = hostValues[sourceKey]!;
				}
			}
		}
		return env;
	}

	async execute(params: Record<string, unknown>): Promise<PluginToolResult> {
		// Approval check before execution
		if (this._approval) {
			const description = `Run plugin tool \`${this.name}\`.`;
			const result = await this._approval.request(
				this.name,
				`plugin:${this.name}`,
				description,
			);
			if (!result.approved) {
				return {
					ok: false,
					output: "Tool execution rejected by user.",
					brief: "Rejected",
				};
			}
		}

		const paramsJson = JSON.stringify(params);

		try {
			const proc = Bun.spawn(this._command, {
				stdin: new Blob([paramsJson]),
				stdout: "pipe",
				stderr: "pipe",
				cwd: this._pluginDir,
				env: this.buildEnv(),
			});

			const timer = setTimeout(() => proc.kill(), 120_000);
			const exitCode = await proc.exited;
			clearTimeout(timer);

			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			const output = stdout.trim();
			const errOutput = stderr.trim();

			if (exitCode !== 0) {
				const errorMsg = errOutput || output || `Exit code ${exitCode}`;
				return {
					ok: false,
					output: `Plugin tool '${this.name}' failed: ${errorMsg}`,
					brief: `Exit ${exitCode}`,
				};
			}

			if (errOutput) {
				logger.debug(`Plugin tool ${this.name} stderr: ${errOutput}`);
			}

			return { ok: true, output };
		} catch (err) {
			return { ok: false, output: String(err), brief: "Runtime error" };
		}
	}
}

/**
 * Scan installed plugins and create PluginTool instances for declared tools.
 */
export function loadPluginTools(
	pluginsDir: string,
	opts?: {
		getHostValues?: () => Record<string, string>;
		approval?: Approval;
	},
): PluginTool[] {
	if (!existsSync(pluginsDir)) return [];
	try {
		if (!statSync(pluginsDir).isDirectory()) return [];
	} catch {
		return [];
	}

	const tools: PluginTool[] = [];
	for (const child of readdirSync(pluginsDir).sort()) {
		const childPath = join(pluginsDir, child);
		const pluginJson = join(childPath, PLUGIN_JSON);
		if (!existsSync(pluginJson)) continue;
		try {
			if (!statSync(childPath).isDirectory()) continue;
		} catch {
			continue;
		}

		let spec: PluginSpec;
		try {
			spec = parsePluginJson(pluginJson);
		} catch {
			continue;
		}

		for (const toolSpec of spec.tools) {
			try {
				tools.push(
					new PluginTool({
						toolSpec,
						pluginDir: childPath,
						inject: spec.inject,
						getHostValues: opts?.getHostValues,
						approval: opts?.approval,
					}),
				);
				logger.info(`Loaded plugin tool: ${toolSpec.name} (from ${spec.name})`);
			} catch {
				logger.warn(
					`Skipping invalid plugin tool: ${toolSpec.name} (from ${spec.name})`,
				);
			}
		}
	}
	return tools;
}
