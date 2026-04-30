/**
 * Toad command — corresponds to Python cli/toad.py
 * Launches the Kimi terminal (Toad) via ACP subcommand.
 */

import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Build the default ACP command to pass to Toad.
 */
function defaultAcpCommand(): string[] {
	const argv0 = process.argv[1] ?? process.argv[0];
	if (argv0) {
		const resolvedPath = resolve(argv0);
		try {
			const { statSync } = require("node:fs");
			statSync(resolvedPath);
			// If it's not a .ts/.js file being run via bun, use it directly
			if (!resolvedPath.endsWith(".ts") && !resolvedPath.endsWith(".js")) {
				return [resolvedPath, "acp"];
			}
		} catch {
			// fall through
		}
	}

	// Fallback: run via bun
	return [process.execPath, argv0 ?? "kimi", "acp"];
}

/**
 * Extract --work-dir / -w from extra args without consuming them.
 */
function extractProjectDir(extraArgs: string[]): string | null {
	let workDir: string | null = null;
	let idx = 0;
	while (idx < extraArgs.length) {
		const arg = extraArgs[idx]!;
		if (arg === "--work-dir" || arg === "-w") {
			if (idx + 1 < extraArgs.length) {
				workDir = extraArgs[idx + 1]!;
				idx += 2;
				continue;
			}
		} else if (arg.startsWith("--work-dir=") || arg.startsWith("-w=")) {
			workDir = arg.split("=", 2)[1]!;
		} else if (arg.startsWith("-w") && arg.length > 2) {
			workDir = arg.slice(2);
		}
		idx += 1;
	}

	if (!workDir) return null;
	return resolve(workDir);
}

export const toadCommand = new Command("term")
	.description("Run Kimi in Toad terminal.")
	.allowUnknownOption(true)
	.allowExcessArguments(true)
	.action((_options: Record<string, unknown>, cmd: Command) => {
		const extraArgs = cmd.args;
		const acpArgs = defaultAcpCommand();
		const acpCommand = acpArgs
			.map((a) => (a.includes(" ") ? `"${a}"` : a))
			.join(" ");

		// Toad requires Bun — check availability
		const toadBin = Bun.which("toad");
		if (!toadBin) {
			console.error(
				"Toad dependency is missing. Install toad to use `kimi term`.",
			);
			process.exit(1);
		}

		const args = [toadBin, "acp", acpCommand];
		const projectDir = extractProjectDir(extraArgs);
		if (projectDir !== null) {
			args.push(projectDir);
		}

		const result = spawnSync(args[0]!, args.slice(1), {
			stdio: "inherit",
		});

		if (result.status !== 0) {
			process.exit(result.status ?? 1);
		}
	});
