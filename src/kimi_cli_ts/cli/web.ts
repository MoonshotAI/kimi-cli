/**
 * Web command — corresponds to Python cli/web.py
 * Launches the Kimi Code CLI web interface.
 */

import { Command } from "commander";

export const webCommand = new Command("web")
	.description("Run Kimi Code CLI web interface.")
	.option("-h, --host <host>", "Bind to specific IP address")
	.option("-n, --network", "Enable network access (bind to 0.0.0.0)")
	.option("-p, --port <port>", "Port to bind to", "5494")
	.option("--open", "Open browser automatically (default)", true)
	.option("--no-open", "Don't open browser automatically")
	.option("--reload", "Enable auto-reload")
	.option("--auth-token <token>", "Bearer token for API authentication")
	.option(
		"--allowed-origins <origins>",
		"Comma-separated list of allowed Origin values",
	)
	.option(
		"--dangerously-omit-auth",
		"Disable auth checks (dangerous in public networks)",
	)
	.option(
		"--restrict-sensitive-apis",
		"Disable sensitive APIs (config write, open-in, file access limits)",
	)
	.option("--no-restrict-sensitive-apis", "Allow sensitive APIs")
	.option("--lan-only", "Only allow access from local network (default)", true)
	.option("--public", "Allow public access")
	.action(
		(options: {
			host?: string;
			network?: boolean;
			port: string;
			open: boolean;
			reload?: boolean;
			authToken?: string;
			allowedOrigins?: string;
			dangerouslyOmitAuth?: boolean;
			restrictSensitiveApis?: boolean;
			lanOnly?: boolean;
			public?: boolean;
		}) => {
			const bindHost =
				options.host ?? (options.network ? "0.0.0.0" : "127.0.0.1");
			const port = parseInt(options.port, 10);
			const lanOnly = options.public ? false : (options.lanOnly ?? true);

			// TODO: Implement web server when web/app.ts is available
			console.log(
				`Kimi Code CLI web interface would start at ${bindHost}:${port}`,
			);
			console.log(`  LAN only: ${lanOnly}`);
			console.log("(Not yet implemented in TypeScript)");
		},
	);
