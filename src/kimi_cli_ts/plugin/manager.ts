/**
 * Plugin manager — corresponds to Python plugin/manager.py
 * Plugin installation, removal, and listing.
 */

import { join, resolve } from "node:path";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
	statSync,
	rmSync,
	cpSync,
	renameSync,
	mkdtempSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { logger } from "../utils/logging.ts";

// ── Types ──

export class PluginError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PluginError";
	}
}

export interface PluginRuntime {
	host: string;
	hostVersion: string;
}

export interface PluginToolSpec {
	name: string;
	description: string;
	command: string[];
	parameters: Record<string, unknown>;
}

export interface PluginSpec {
	name: string;
	version: string;
	description: string;
	configFile?: string;
	inject: Record<string, string>;
	tools: PluginToolSpec[];
	runtime?: PluginRuntime;
}

export const PLUGIN_JSON = "plugin.json";

// ── Parsing ──

export function parsePluginJson(path: string): PluginSpec {
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		throw new PluginError(`Failed to read ${path}: ${err}`);
	}

	if (!data.name)
		throw new PluginError(`Missing required field 'name' in ${path}`);
	if (!data.version)
		throw new PluginError(`Missing required field 'version' in ${path}`);
	if (data.inject && !data.config_file) {
		throw new PluginError(`'inject' requires 'config_file' in ${path}`);
	}

	const tools: PluginToolSpec[] = [];
	if (Array.isArray(data.tools)) {
		for (const t of data.tools) {
			tools.push({
				name: String(t.name ?? ""),
				description: String(t.description ?? ""),
				command: Array.isArray(t.command) ? t.command.map(String) : [],
				parameters: (t.parameters as Record<string, unknown>) ?? {},
			});
		}
	}

	const runtime = data.runtime as Record<string, unknown> | undefined;

	return {
		name: String(data.name),
		version: String(data.version),
		description: String(data.description ?? ""),
		configFile: data.config_file ? String(data.config_file) : undefined,
		inject: (data.inject as Record<string, string>) ?? {},
		tools,
		runtime: runtime
			? {
					host: String(runtime.host ?? ""),
					hostVersion: String(runtime.host_version ?? ""),
				}
			: undefined,
	};
}

// ── Directory helpers ──

export function getPluginsDir(): string {
	const shareDir = join(homedir(), ".kimi");
	return join(shareDir, "plugins");
}

// ── Config injection ──

function setNested(
	obj: Record<string, unknown>,
	dottedPath: string,
	value: unknown,
): void {
	const keys = dottedPath.split(".");
	let current = obj;
	for (let i = 0; i < keys.length - 1; i++) {
		const key = keys[i]!;
		if (
			!(key in current) ||
			typeof current[key] !== "object" ||
			current[key] === null
		) {
			current[key] = {};
		}
		current = current[key] as Record<string, unknown>;
	}
	current[keys[keys.length - 1]!] = value;
}

export function injectConfig(
	pluginDir: string,
	spec: PluginSpec,
	values: Record<string, string>,
): void {
	if (!spec.inject || !spec.configFile) return;

	const configPath = resolve(join(pluginDir, spec.configFile));
	if (!configPath.startsWith(resolve(pluginDir))) {
		throw new PluginError(
			`config_file escapes plugin directory: ${spec.configFile}`,
		);
	}
	if (!existsSync(configPath)) {
		throw new PluginError(`Config file not found: ${configPath}`);
	}

	let config: Record<string, unknown>;
	try {
		config = JSON.parse(readFileSync(configPath, "utf-8"));
	} catch (err) {
		throw new PluginError(`Failed to read config file ${configPath}: ${err}`);
	}

	for (const [targetPath, sourceKey] of Object.entries(spec.inject)) {
		if (!(sourceKey in values)) {
			throw new PluginError(
				`Host does not provide required inject key '${sourceKey}'`,
			);
		}
		setNested(config, targetPath, values[sourceKey]!);
	}

	writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

export function writeRuntime(pluginDir: string, runtime: PluginRuntime): void {
	const pluginJsonPath = join(pluginDir, PLUGIN_JSON);
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(readFileSync(pluginJsonPath, "utf-8"));
	} catch (err) {
		throw new PluginError(`Failed to read ${pluginJsonPath}: ${err}`);
	}
	data.runtime = { host: runtime.host, host_version: runtime.hostVersion };
	writeFileSync(pluginJsonPath, JSON.stringify(data, null, 2), "utf-8");
}

// ── Installation ──

function validateName(name: string, pluginsDir: string): string {
	const dest = resolve(join(pluginsDir, name));
	if (!dest.startsWith(resolve(pluginsDir))) {
		throw new PluginError(`Invalid plugin name: ${name}`);
	}
	return dest;
}

export function installPlugin(opts: {
	source: string;
	pluginsDir: string;
	hostValues: Record<string, string>;
	hostName: string;
	hostVersion: string;
}): PluginSpec {
	const sourcePluginJson = join(opts.source, PLUGIN_JSON);
	if (!existsSync(sourcePluginJson)) {
		throw new PluginError(`No plugin.json found in ${opts.source}`);
	}

	const spec = parsePluginJson(sourcePluginJson);
	const dest = validateName(spec.name, opts.pluginsDir);

	mkdirSync(opts.pluginsDir, { recursive: true });
	const staging = mkdtempSync(join(opts.pluginsDir, `.${spec.name}-`));

	try {
		const stagingPlugin = join(staging, spec.name);
		cpSync(opts.source, stagingPlugin, { recursive: true });

		injectConfig(stagingPlugin, spec, opts.hostValues);
		writeRuntime(stagingPlugin, {
			host: opts.hostName,
			hostVersion: opts.hostVersion,
		});

		if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
		renameSync(stagingPlugin, dest);
	} catch (err) {
		rmSync(staging, { recursive: true, force: true });
		throw err;
	} finally {
		try {
			rmSync(staging, { recursive: true, force: true });
		} catch {
			// Ignore
		}
	}

	return parsePluginJson(join(dest, PLUGIN_JSON));
}

export function refreshPluginConfigs(
	pluginsDir: string,
	hostValues: Record<string, string>,
): void {
	if (!existsSync(pluginsDir)) return;
	try {
		if (!statSync(pluginsDir).isDirectory()) return;
	} catch {
		return;
	}

	for (const child of readdirSync(pluginsDir).sort()) {
		const childPath = join(pluginsDir, child);
		const pluginJson = join(childPath, PLUGIN_JSON);
		try {
			if (!statSync(childPath).isDirectory() || !existsSync(pluginJson))
				continue;
			const spec = parsePluginJson(pluginJson);
			if (spec.inject && spec.configFile) {
				injectConfig(childPath, spec, hostValues);
			}
		} catch {
			continue;
		}
	}
}

export function listPlugins(pluginsDir: string): PluginSpec[] {
	if (!existsSync(pluginsDir)) return [];
	try {
		if (!statSync(pluginsDir).isDirectory()) return [];
	} catch {
		return [];
	}

	const plugins: PluginSpec[] = [];
	for (const child of readdirSync(pluginsDir).sort()) {
		const childPath = join(pluginsDir, child);
		const pluginJson = join(childPath, PLUGIN_JSON);
		try {
			if (statSync(childPath).isDirectory() && existsSync(pluginJson)) {
				plugins.push(parsePluginJson(pluginJson));
			}
		} catch {
			continue;
		}
	}
	return plugins;
}

export function removePlugin(name: string, pluginsDir: string): void {
	const dest = validateName(name, pluginsDir);
	if (!existsSync(dest)) {
		throw new PluginError(`Plugin '${name}' not found in ${pluginsDir}`);
	}
	rmSync(dest, { recursive: true, force: true });
}
