/**
 * Plugin management CLI — corresponds to Python cli/plugin.py
 */

import { Command } from "commander";
import { join, resolve } from "node:path";
import {
	existsSync,
	statSync,
	readdirSync,
	rmSync,
	mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";

import {
	getPluginsDir,
	installPlugin,
	listPlugins,
	removePlugin,
	parsePluginJson,
	PluginError,
	PLUGIN_JSON,
} from "../plugin/manager.ts";
import { collectHostValues } from "../plugin/tool.ts";

// ── Git URL parsing ──────────────────────────────────────

function parseGitUrl(target: string): {
	cloneUrl: string;
	subpath: string | undefined;
	branch: string | undefined;
} {
	// Path 1: URL contains .git followed by / or end-of-string
	const idx = target.indexOf(".git/");
	if (idx === -1 && target.endsWith(".git")) {
		return { cloneUrl: target, subpath: undefined, branch: undefined };
	}
	if (idx !== -1) {
		const cloneUrl = target.slice(0, idx + 4);
		const rest =
			target
				.slice(idx + 5)
				.replace(/^\/+|\/+$/g, "")
				.trim() || undefined;
		return { cloneUrl, subpath: rest, branch: undefined };
	}

	// Path 2: GitHub/GitLab short URL (no .git)
	let url: URL;
	try {
		url = new URL(target);
	} catch {
		return { cloneUrl: target, subpath: undefined, branch: undefined };
	}

	const segments = url.pathname.split("/").filter(Boolean);
	if (segments.length < 2) {
		return { cloneUrl: target, subpath: undefined, branch: undefined };
	}

	const ownerRepo = segments.slice(0, 2).join("/");
	const cloneUrl = `${url.protocol}//${url.host}/${ownerRepo}`;
	let restSegments = segments.slice(2);

	// GitLab uses /-/tree/{branch}/
	if (restSegments.length > 0 && restSegments[0] === "-") {
		restSegments = restSegments.slice(1);
	}

	// Strip tree/{branch}/ prefix
	let branch: string | undefined;
	if (restSegments.length >= 2 && restSegments[0] === "tree") {
		branch = restSegments[1];
		restSegments = restSegments.slice(2);
	}

	const subpath = restSegments.join("/") || undefined;
	return { cloneUrl, subpath, branch };
}

function isGitUrl(target: string): boolean {
	return (
		(target.startsWith("https://") ||
			target.startsWith("git@") ||
			target.startsWith("http://")) &&
		(target.includes(".git/") ||
			target.endsWith(".git") ||
			target.includes("github.com/") ||
			target.includes("gitlab.com/"))
	);
}

// ── Source resolution ────────────────────────────────────

function resolveSource(target: string): {
	sourceDir: string;
	tmpDir: string | null;
} {
	const { execSync } = require("node:child_process");

	// --- Git URL ---
	if (isGitUrl(target)) {
		const { cloneUrl, subpath, branch } = parseGitUrl(target);
		const tmp = mkdtempSync(join(tmpdir(), "kimi-plugin-"));
		const repoDir = join(tmp, "repo");

		console.log(`Cloning ${cloneUrl}...`);
		const cloneCmd = ["git", "clone", "--depth", "1"];
		if (branch) cloneCmd.push("--branch", branch);
		cloneCmd.push(cloneUrl, repoDir);

		try {
			execSync(cloneCmd.join(" "), { stdio: "pipe" });
		} catch (err: unknown) {
			rmSync(tmp, { recursive: true, force: true });
			const stderr =
				err && typeof err === "object" && "stderr" in err
					? String((err as { stderr: Buffer }).stderr).trim()
					: String(err);
			console.error(`Error: git clone failed: ${stderr}`);
			process.exit(1);
		}

		if (subpath) {
			const source = resolve(join(repoDir, subpath));
			if (!source.startsWith(resolve(repoDir))) {
				rmSync(tmp, { recursive: true, force: true });
				console.error(`Error: subpath escapes repository: ${subpath}`);
				process.exit(1);
			}
			if (!existsSync(source) || !statSync(source).isDirectory()) {
				rmSync(tmp, { recursive: true, force: true });
				console.error(`Error: subpath '${subpath}' not found in repository`);
				process.exit(1);
			}
			if (!existsSync(join(source, PLUGIN_JSON))) {
				rmSync(tmp, { recursive: true, force: true });
				console.error(`Error: no plugin.json in '${subpath}'`);
				process.exit(1);
			}
			return { sourceDir: source, tmpDir: tmp };
		}

		// No subpath — check root first
		if (existsSync(join(repoDir, PLUGIN_JSON))) {
			return { sourceDir: repoDir, tmpDir: tmp };
		}

		// Scan one level for available plugins
		const available = readdirSync(repoDir)
			.filter((d) => {
				try {
					return (
						statSync(join(repoDir, d)).isDirectory() &&
						existsSync(join(repoDir, d, PLUGIN_JSON))
					);
				} catch {
					return false;
				}
			})
			.sort();

		if (available.length > 0) {
			const names = available.map((n) => `  - ${n}`).join("\n");
			console.error(
				`Error: No plugin.json at repository root. Available plugins:\n${names}\n` +
					`Use: kimi plugin install <url>/<plugin-name>`,
			);
		} else {
			console.error("Error: No plugin.json found in repository");
		}
		rmSync(tmp, { recursive: true, force: true });
		process.exit(1);
	}

	const p = resolve(target);

	// --- Zip file ---
	if (existsSync(p) && statSync(p).isFile() && p.endsWith(".zip")) {
		const tmp = mkdtempSync(join(tmpdir(), "kimi-plugin-"));
		console.log(`Extracting ${target}...`);

		try {
			execSync(`unzip -q "${p}" -d "${tmp}"`, { stdio: "pipe" });
		} catch (err) {
			rmSync(tmp, { recursive: true, force: true });
			console.error(`Error: failed to extract zip: ${err}`);
			process.exit(1);
		}

		// Find directory containing plugin.json (may be nested one level)
		const candidates = [
			tmp,
			...readdirSync(tmp)
				.sort()
				.map((d) => join(tmp, d))
				.filter((d) => {
					try {
						return statSync(d).isDirectory();
					} catch {
						return false;
					}
				}),
		];

		for (const candidate of candidates) {
			if (existsSync(join(candidate, PLUGIN_JSON))) {
				return { sourceDir: candidate, tmpDir: tmp };
			}
		}

		// Check for __MACOSX and similar artifacts
		const dirs = readdirSync(tmp)
			.filter((d) => !d.startsWith("_"))
			.map((d) => join(tmp, d))
			.filter((d) => {
				try {
					return statSync(d).isDirectory();
				} catch {
					return false;
				}
			});

		if (dirs.length === 1 && existsSync(join(dirs[0]!, PLUGIN_JSON))) {
			return { sourceDir: dirs[0]!, tmpDir: tmp };
		}

		rmSync(tmp, { recursive: true, force: true });
		console.error("Error: No plugin.json found in zip");
		process.exit(1);
	}

	// --- Local directory ---
	if (existsSync(p) && statSync(p).isDirectory()) {
		return { sourceDir: p, tmpDir: null };
	}

	console.error(`Error: ${target} is not a directory, zip file, or git URL`);
	process.exit(1);
}

// ── Command ──────────────────────────────────────────────

export const pluginCommand = new Command("plugin").description(
	"Manage plugins.",
);

pluginCommand
	.command("install")
	.description("Install a plugin and inject host configuration.")
	.argument("<target>", "Plugin source: directory, .zip, or git URL")
	.action(async (target: string) => {
		const { sourceDir, tmpDir } = resolveSource(target);

		try {
			const { loadConfig } = await import("../config.ts");
			const { VERSION } = await import("../constant.ts");

			const { config } = await loadConfig();

			// Collect host values for config injection
			let hostValues: Record<string, string> = {};
			try {
				const { OAuthManager } = await import("../auth/oauth.ts");
				const oauth = new OAuthManager(config);
				hostValues = collectHostValues(
					config as unknown as Parameters<typeof collectHostValues>[0],
					oauth as unknown as Parameters<typeof collectHostValues>[1],
				);
			} catch {
				// OAuth may not be available
			}

			if (!hostValues["api_key"]) {
				console.error(
					"Warning: No LLM provider configured. " +
						"Plugins requiring API key injection will fail. " +
						"Run 'kimi login' or configure a provider first.",
				);
			}

			const spec = installPlugin({
				source: sourceDir,
				pluginsDir: getPluginsDir(),
				hostValues,
				hostName: "kimi-code",
				hostVersion: VERSION,
			});

			console.log(`Installed plugin '${spec.name}' v${spec.version}`);
			if (spec.runtime) {
				console.log(
					`  runtime: host=${spec.runtime.host}, version=${spec.runtime.hostVersion}`,
				);
			}
		} catch (err) {
			if (err instanceof PluginError) {
				console.error(`Error: ${err.message}`);
				process.exit(1);
			}
			throw err;
		} finally {
			if (tmpDir) {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		}
	});

pluginCommand
	.command("list")
	.description("List installed plugins.")
	.action(() => {
		const plugins = listPlugins(getPluginsDir());
		if (plugins.length === 0) {
			console.log("No plugins installed.");
			return;
		}
		for (const p of plugins) {
			const status = p.runtime ? "installed" : "not configured";
			console.log(`  ${p.name} v${p.version} (${status})`);
		}
	});

pluginCommand
	.command("remove")
	.description("Remove an installed plugin.")
	.argument("<name>", "Plugin name to remove")
	.action((name: string) => {
		try {
			removePlugin(name, getPluginsDir());
		} catch (err) {
			if (err instanceof PluginError) {
				console.error(`Error: ${err.message}`);
				process.exit(1);
			}
			throw err;
		}
		console.log(`Removed plugin '${name}'`);
	});

pluginCommand
	.command("info")
	.description("Show plugin details.")
	.argument("<name>", "Plugin name")
	.action((name: string) => {
		const pluginJson = join(getPluginsDir(), name, PLUGIN_JSON);
		if (!existsSync(pluginJson)) {
			console.error(`Error: Plugin '${name}' not found`);
			process.exit(1);
		}

		let spec;
		try {
			spec = parsePluginJson(pluginJson);
		} catch (err) {
			if (err instanceof PluginError) {
				console.error(`Error: ${err.message}`);
				process.exit(1);
			}
			throw err;
		}

		console.log(`Name:        ${spec.name}`);
		console.log(`Version:     ${spec.version}`);
		console.log(`Description: ${spec.description || "(none)"}`);
		console.log(`Config file: ${spec.configFile || "(none)"}`);

		if (Object.keys(spec.inject).length > 0) {
			const pairs = Object.entries(spec.inject)
				.map(([k, v]) => `${k} <- ${v}`)
				.join(", ");
			console.log(`Inject:      ${pairs}`);
		}

		if (spec.runtime) {
			console.log(
				`Runtime:     host=${spec.runtime.host}, version=${spec.runtime.hostVersion}`,
			);
		} else {
			console.log("Runtime:     (not installed via host)");
		}
	});
