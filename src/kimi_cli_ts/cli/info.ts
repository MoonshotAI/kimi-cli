/**
 * CLI info command — corresponds to Python cli/info.py
 * Displays version, agent spec, wire protocol, and runtime info.
 */

import { Command } from "commander";

interface InfoData {
	kimi_cli_version: string;
	wire_protocol_version: string;
	runtime: string;
	runtime_version: string;
}

function collectInfo(): InfoData {
	// Lazy imports to avoid circular dependencies at module load time
	const { getVersion } = require("../constant.ts");
	let wireProtocolVersion = "unknown";
	try {
		const wire = require("../wire/protocol.ts");
		wireProtocolVersion = wire.WIRE_PROTOCOL_VERSION ?? "unknown";
	} catch {
		// wire module may not be available
	}

	return {
		kimi_cli_version: getVersion(),
		wire_protocol_version: wireProtocolVersion,
		runtime: "bun",
		runtime_version: typeof Bun !== "undefined" ? Bun.version : process.version,
	};
}

export const infoCommand = new Command("info")
	.description("Show version and protocol information.")
	.option("--json", "Output information as JSON.", false)
	.action((options: { json?: boolean }) => {
		const info = collectInfo();

		if (options.json) {
			console.log(JSON.stringify(info, null, 2));
			return;
		}

		console.log(`kimi-cli version: ${info.kimi_cli_version}`);
		console.log(`wire protocol: ${info.wire_protocol_version}`);
		console.log(`runtime: ${info.runtime} ${info.runtime_version}`);
	});
