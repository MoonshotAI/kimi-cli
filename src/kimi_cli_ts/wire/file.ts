/**
 * Wire file — JSONL-based message log.
 * Corresponds to Python's wire/file.py
 */

import { z } from "zod/v4";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
	WIRE_PROTOCOL_LEGACY_VERSION,
	WIRE_PROTOCOL_VERSION,
} from "./protocol.ts";
import {
	type WireMessage,
	type WireMessageEnvelope,
	WireMessageEnvelopeSchema,
	fromEnvelope,
} from "./types.ts";
import { serializeWireMessage } from "./serde.ts";

// ── Record Types ───────────────────────────────────────────

export const WireFileMetadata = z.object({
	type: z.literal("metadata"),
	protocol_version: z.string(),
});
export type WireFileMetadata = z.infer<typeof WireFileMetadata>;

export const WireMessageRecord = z.object({
	timestamp: z.number(),
	message: WireMessageEnvelopeSchema,
});
export type WireMessageRecord = z.infer<typeof WireMessageRecord>;

// ── Parsing helpers ────────────────────────────────────────

/**
 * Parse a wire file metadata line; returns null if not metadata.
 */
export function parseWireFileMetadata(line: string): WireFileMetadata | null {
	try {
		const data = JSON.parse(line);
		const result = WireFileMetadata.safeParse(data);
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}

/**
 * Parse a wire file line into metadata or a message record.
 */
export function parseWireFileLine(
	line: string,
): WireFileMetadata | WireMessageRecord {
	const metadata = parseWireFileMetadata(line);
	if (metadata !== null) return metadata;
	return WireMessageRecord.parse(JSON.parse(line));
}

/**
 * Convert a WireMessageRecord to a WireMessage.
 */
export function recordToWireMessage(record: WireMessageRecord): unknown {
	return fromEnvelope(record.message).message;
}

// ── Ensure directory exists ────────────────────────────────

async function ensureDir(dirPath: string): Promise<void> {
	await mkdir(dirPath, { recursive: true });
}

// ── Protocol version detection ─────────────────────────────

function loadProtocolVersion(path: string): string | null {
	try {
		const file = Bun.file(path);
		// Sync existence check via size — Bun.file for non-existent files has size 0
		// We need to try reading synchronously for constructor use
		const text = readFileSync(path);
		if (!text) return null;
		const lines = text.split("\n");
		for (const rawLine of lines) {
			const line = rawLine.trim();
			if (!line) continue;
			const metadata = parseWireFileMetadata(line);
			if (metadata === null) return null;
			return metadata.protocol_version;
		}
	} catch {
		// File doesn't exist or can't be read
	}
	return null;
}

/**
 * Synchronous file read helper (Bun-specific).
 */
function readFileSync(path: string): string | null {
	try {
		const file = Bun.file(path);
		// Bun doesn't have a true sync read, but we can use node:fs
		const fs = require("node:fs");
		return fs.readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

function fileExists(path: string): boolean {
	try {
		const fs = require("node:fs");
		return fs.existsSync(path);
	} catch {
		return false;
	}
}

// ── WireFile class ─────────────────────────────────────────

export class WireFile {
	readonly path: string;
	protocolVersion: string;

	constructor(path: string) {
		this.path = path;

		if (fileExists(path)) {
			const version = loadProtocolVersion(path);
			this.protocolVersion =
				version !== null ? version : WIRE_PROTOCOL_LEGACY_VERSION;
		} else {
			this.protocolVersion = WIRE_PROTOCOL_VERSION;
		}
	}

	get version(): string {
		return this.protocolVersion;
	}

	/**
	 * Check if the wire file is empty (no message records).
	 */
	async isEmpty(): Promise<boolean> {
		const file = Bun.file(this.path);
		if ((await file.exists()) === false) return true;

		// Use streaming line reader instead of loading entire file
		const stream = file.stream();
		const decoder = new TextDecoder();
		let remainder = "";

		for await (const chunk of stream) {
			remainder += decoder.decode(chunk, { stream: true });
			const lines = remainder.split("\n");
			remainder = lines.pop()!;

			for (const rawLine of lines) {
				const trimmed = rawLine.trim();
				if (!trimmed) continue;
				if (parseWireFileMetadata(trimmed) !== null) continue;
				return false;
			}
		}
		// Check remainder
		const trimmed = remainder.trim();
		if (trimmed && parseWireFileMetadata(trimmed) === null) {
			return false;
		}
		return true;
	}

	/**
	 * Iterate over all message records in the file using streaming line reads.
	 */
	async *iterRecords(): AsyncGenerator<WireMessageRecord> {
		const file = Bun.file(this.path);
		if ((await file.exists()) === false) return;

		try {
			const stream = file.stream();
			const decoder = new TextDecoder();
			let remainder = "";

			for await (const chunk of stream) {
				remainder += decoder.decode(chunk, { stream: true });
				const lines = remainder.split("\n");
				remainder = lines.pop()!;

				for (const rawLine of lines) {
					const trimmed = rawLine.trim();
					if (!trimmed) continue;
					try {
						const parsed = parseWireFileLine(trimmed);
						if ("type" in parsed && parsed.type === "metadata") {
							this.protocolVersion = (
								parsed as WireFileMetadata
							).protocol_version;
							continue;
						}
						yield parsed as WireMessageRecord;
					} catch (err) {
						console.error(
							`Failed to parse line in wire file ${this.path}:`,
							err,
						);
						continue;
					}
				}
			}

			// Handle any remaining data
			const trimmed = remainder.trim();
			if (trimmed) {
				try {
					const parsed = parseWireFileLine(trimmed);
					if (!("type" in parsed && parsed.type === "metadata")) {
						yield parsed as WireMessageRecord;
					}
				} catch (err) {
					console.error(`Failed to parse line in wire file ${this.path}:`, err);
				}
			}
		} catch (err) {
			console.error(`Failed to read wire file ${this.path}:`, err);
		}
	}

	/**
	 * Append a wire message to the file.
	 * Accepts either (typeName, payload) or a WireMessage object.
	 */
	async appendMessage(
		typeNameOrMsg: string | WireMessage | Record<string, unknown>,
		payloadOrTimestamp?: Record<string, unknown> | number,
		timestamp?: number,
	): Promise<void> {
		let envelope: Record<string, unknown>;
		let ts: number;

		if (typeof typeNameOrMsg === "string") {
			// (typeName, payload, timestamp?)
			envelope = serializeWireMessage(
				typeNameOrMsg,
				payloadOrTimestamp as Record<string, unknown>,
			);
			ts = timestamp ?? Date.now() / 1000;
		} else {
			// (msg, timestamp?)
			envelope = serializeWireMessage(typeNameOrMsg);
			ts =
				typeof payloadOrTimestamp === "number"
					? payloadOrTimestamp
					: Date.now() / 1000;
		}

		const record: WireMessageRecord = {
			timestamp: ts,
			message: envelope as WireMessageEnvelope,
		};
		await this.appendRecord(record);
	}

	/**
	 * Append a raw record to the wire file.
	 */
	async appendRecord(record: WireMessageRecord): Promise<void> {
		// Ensure parent directory exists
		await ensureDir(dirname(this.path));

		const file = Bun.file(this.path);
		const exists = await file.exists();
		const needsHeader = !exists || file.size === 0;

		let content = "";
		if (needsHeader) {
			const metadata: WireFileMetadata = {
				type: "metadata",
				protocol_version: this.protocolVersion,
			};
			content += JSON.stringify(metadata) + "\n";
		}
		content += JSON.stringify(record) + "\n";

		// Append to file (not overwrite!)
		const { appendFile: fsAppendFile } = await import("node:fs/promises");
		await fsAppendFile(this.path, content, "utf-8");
	}

	toString(): string {
		return this.path;
	}
}
