/**
 * CLI logout command — corresponds to Python cli logout() command
 * Clears OAuth tokens and config.
 */

import { Command } from "commander";

export const logoutCommand = new Command("logout")
	.description("Logout from your Kimi account.")
	.option("--json", "Emit OAuth events as JSON lines.", false)
	.action(async (options: { json?: boolean }) => {
		const { logoutKimiCode } = await import("../auth/oauth.ts");
		const { loadConfig } = await import("../config.ts");

		const { config } = await loadConfig();
		let ok = true;

		if (options.json) {
			for await (const event of logoutKimiCode(config)) {
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
			for await (const event of logoutKimiCode(config)) {
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
