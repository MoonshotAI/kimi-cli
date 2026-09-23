/**
 * Web runner worker — corresponds to Python web/runner/worker.py
 * Entry point for the worker subprocess that runs a kimi-cli session.
 *
 * The worker reads JSON-RPC messages from stdin and writes responses to stdout.
 * It is spawned by SessionProcess.start().
 */

import { parseArgs } from "node:util";
import { logger } from "../../utils/logging.ts";

async function runWorker(sessionId: string): Promise<void> {
	logger.info(`Worker starting for session: ${sessionId}`);

	const sessionDir = process.env.KIMI_SESSION_DIR;
	if (!sessionDir) {
		throw new Error("KIMI_SESSION_DIR not set");
	}

	// Dynamic import to avoid circular dependencies
	const { loadSessionById } = await import("../store/sessions.ts");
	const session = loadSessionById(sessionId);
	if (!session) {
		throw new Error(`Session not found: ${sessionId}`);
	}

	// TODO: Wire up KimiCLI.create + wire_stdio when the full integration is ready.
	// For now, the worker is a stub that reads stdin and logs messages.
	const decoder = new TextDecoder();
	const reader = Bun.stdin.stream().getReader();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });

			let newlineIdx: number;
			while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newlineIdx).trim();
				buffer = buffer.slice(newlineIdx + 1);

				if (!line) continue;

				try {
					const msg = JSON.parse(line);
					logger.debug(`Worker received: ${msg.method ?? "response"}`);

					// Echo back a success response for now
					if (msg.id && msg.method) {
						const response = {
							jsonrpc: "2.0",
							id: msg.id,
							result: { status: "ok" },
						};
						process.stdout.write(JSON.stringify(response) + "\n");
					}
				} catch (err) {
					logger.warn(`Worker parse error: ${err}`);
				}
			}
		}
	} catch (err) {
		logger.error(`Worker error: ${err}`);
	}

	logger.info(`Worker exiting for session: ${sessionId}`);
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			"session-id": { type: "string" },
		},
		strict: true,
		allowPositionals: false,
	});

	const sessionId = values["session-id"];
	if (!sessionId) {
		console.error("Usage: worker --session-id <uuid>");
		process.exit(1);
	}

	// Set process title
	try {
		process.title = `kimi-worker-${sessionId.slice(0, 8)}`;
	} catch {
		// ignore
	}

	await runWorker(sessionId);
}

// Run if executed directly
main().catch((err) => {
	console.error("Worker fatal error:", err);
	process.exit(1);
});
