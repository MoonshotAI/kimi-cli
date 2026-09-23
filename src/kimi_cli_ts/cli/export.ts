/**
 * CLI export command — corresponds to Python cli/export.py
 * Exports a session as a ZIP archive.
 */

import { Command } from "commander";
import { join, resolve } from "node:path";
import {
	readdirSync,
	statSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	existsSync,
} from "node:fs";
import { Session } from "../session.ts";
import { getShareDir } from "../config.ts";
import {
	parseWireFileLine,
	type WireFileMetadata,
	type WireMessageRecord,
} from "../wire/file.ts";
import { fromEnvelope } from "../wire/types.ts";
import * as readline from "node:readline";

// ── Helpers ──────────────────────────────────────────────

function lastUserMessageTimestamp(sessionDir: string): number | null {
	const wireFile = join(sessionDir, "wire.jsonl");
	if (!existsSync(wireFile)) return null;

	let lastTurnBegin: number | null = null;
	try {
		const content = readFileSync(wireFile, "utf-8");
		for (const rawLine of content.split("\n")) {
			const line = rawLine.trim();
			if (!line) continue;
			try {
				const parsed = parseWireFileLine(line);
				if ("type" in parsed && parsed.type === "metadata") continue;
				const record = parsed as WireMessageRecord;
				try {
					const { typeName } = fromEnvelope(record.message);
					if (typeName === "TurnBegin") {
						lastTurnBegin = record.timestamp;
					}
				} catch {
					continue;
				}
			} catch {
				continue;
			}
		}
	} catch {
		return null;
	}

	return lastTurnBegin;
}

function formatMessageTimestamp(timestamp: number | null): string {
	if (timestamp === null) return "(no user message)";
	return new Date(timestamp * 1000)
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, " UTC");
}

function confirmPrompt(message: string): Promise<boolean> {
	return new Promise((res) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			res(answer.trim().toLowerCase() === "y");
		});
	});
}

function confirmPreviousSession(session: Session): Promise<boolean> {
	const lastUserMessage = formatMessageTimestamp(
		lastUserMessageTimestamp(session.dir),
	);

	console.log(
		"About to export the previous session for this working directory:",
	);
	console.log();
	console.log(`Work dir: ${session.workDir}`);
	console.log(`Session ID: ${session.id}`);
	console.log(`Title: ${session.title}`);
	console.log(`Last user message: ${lastUserMessage}`);
	console.log();
	return confirmPrompt("Export this session?");
}

function findSessionById(sessionId: string): string | null {
	const sessionsRoot = join(getShareDir(), "sessions");
	if (!existsSync(sessionsRoot)) return null;

	try {
		for (const workDirHash of readdirSync(sessionsRoot)) {
			const workDirHashDir = join(sessionsRoot, workDirHash);
			try {
				if (!statSync(workDirHashDir).isDirectory()) continue;
			} catch {
				continue;
			}
			const candidate = join(workDirHashDir, sessionId);
			try {
				if (statSync(candidate).isDirectory()) return candidate;
			} catch {
				continue;
			}
		}
	} catch {
		// ignore
	}
	return null;
}

export const exportCommand = new Command("export")
	.description("Export a session as a ZIP archive.")
	.argument(
		"[session-id]",
		"Session ID to export. Defaults to the previous session.",
	)
	.option(
		"-o, --output <path>",
		"Output ZIP file path. Default: session-{id}.zip in current directory.",
	)
	.option(
		"-y, --yes",
		"Skip confirmation when exporting the previous session by default.",
	)
	.action(
		async (
			sessionId: string | undefined,
			options: { output?: string; yes?: boolean },
		) => {
			const workDir = resolve(process.cwd());

			let resolvedSessionId: string;
			let sessionDir: string;

			if (!sessionId) {
				// No session ID provided — use the previous session for this work dir
				const session = await Session.continue_(workDir);
				if (!session) {
					console.error(
						"Error: no previous session found for the working directory.",
					);
					process.exit(1);
				}
				if (!options.yes) {
					const confirmed = await confirmPreviousSession(session);
					if (!confirmed) {
						console.log("Export cancelled.");
						return;
					}
				}
				resolvedSessionId = session.id;
				sessionDir = session.dir;
			} else {
				// Explicit session ID — try work-dir-scoped find first, then global
				const session = await Session.find(workDir, sessionId);
				if (session) {
					resolvedSessionId = session.id;
					sessionDir = session.dir;
				} else {
					const found = findSessionById(sessionId);
					if (!found) {
						console.error(`Error: session '${sessionId}' not found.`);
						process.exit(1);
					}
					resolvedSessionId = sessionId;
					sessionDir = found;
				}
			}

			// Collect files
			let files: string[];
			try {
				files = readdirSync(sessionDir)
					.filter((f) => {
						try {
							return statSync(join(sessionDir, f)).isFile();
						} catch {
							return false;
						}
					})
					.sort();
			} catch {
				files = [];
			}

			if (files.length === 0) {
				console.error(`Error: session '${resolvedSessionId}' has no files.`);
				process.exit(1);
			}

			// Determine output path
			const outputPath = options.output
				? resolve(options.output)
				: resolve(process.cwd(), `session-${resolvedSessionId}.zip`);

			// Use shell zip command
			try {
				const outputDir = outputPath.substring(0, outputPath.lastIndexOf("/"));
				mkdirSync(outputDir, { recursive: true });

				const fileArgs = files.map((f) => join(sessionDir, f));
				await Bun.$`zip -j ${outputPath} ${fileArgs}`.quiet();
				console.log(outputPath);
			} catch (err) {
				console.error(`Error creating ZIP: ${err}`);
				process.exit(1);
			}
		},
	);
