/**
 * Vis command — corresponds to Python cli/vis.py
 * Launches the Kimi Agent Tracing Visualizer.
 */

import { Command } from "commander";

export const visCommand = new Command("vis")
	.description("Run Kimi Agent Tracing Visualizer.")
	.option("-h, --host <host>", "Bind to specific IP address")
	.option("-n, --network", "Enable network access (bind to 0.0.0.0)")
	.option("-p, --port <port>", "Port to bind to", "5495")
	.option("--open", "Open browser automatically (default)", true)
	.option("--no-open", "Don't open browser automatically")
	.option("--reload", "Enable auto-reload")
	.action(
		(options: {
			host?: string;
			network?: boolean;
			port: string;
			open: boolean;
			reload?: boolean;
		}) => {
			const bindHost =
				options.host ?? (options.network ? "0.0.0.0" : "127.0.0.1");
			const port = parseInt(options.port, 10);

			// TODO: Implement vis server when vis/app.ts is available
			console.log(
				`Kimi Agent Tracing Visualizer would start at ${bindHost}:${port}`,
			);
			console.log("(Not yet implemented in TypeScript)");
		},
	);
