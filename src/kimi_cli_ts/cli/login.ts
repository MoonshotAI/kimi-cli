/**
 * CLI login command — corresponds to Python cli login() command
 * Device-code OAuth flow with console/JSON output.
 */

import { Command } from "commander";
import { logger } from "../utils/logging.ts";

export const loginCommand = new Command("login")
	.description("Login to your Kimi account.")
	.option("--json", "Emit OAuth events as JSON lines.", false)
	.action(async (options: { json?: boolean }) => {
		const { loginKimiCode } = await import("../auth/oauth.ts");
		const { loadConfig } = await import("../config.ts");

		const { config } = await loadConfig();
		let ok = true;

		if (options.json) {
			for await (const event of loginKimiCode(config)) {
				console.log(
					JSON.stringify({
						type: event.type,
						message: event.message,
						...(event.data ? { data: event.data } : {}),
					}),
				);
				if (event.type === "error") ok = false;
			}
		} else {
			let waiting = false;
			for await (const event of loginKimiCode(config)) {
				if (event.type === "waiting") {
					if (!waiting) {
						logger.info("Waiting for user authorization...");
						waiting = true;
					}
					continue;
				}
				waiting = false;
				const color =
					event.type === "error"
						? "\x1b[31m"
						: event.type === "success"
							? "\x1b[32m"
							: "";
				const reset = color ? "\x1b[0m" : "";
				console.log(`${color}${event.message}${reset}`);
				if (event.type === "error") ok = false;
			}
		}

		if (!ok) process.exit(1);
	});
