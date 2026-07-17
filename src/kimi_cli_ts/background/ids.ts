/**
 * Background task ID generation — corresponds to Python background/ids.py
 */

import type { TaskKind } from "./models.ts";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

const TASK_ID_PREFIXES: Record<TaskKind, string> = {
	bash: "bash",
	agent: "agent",
};

export function generateTaskId(kind: TaskKind): string {
	const prefix = TASK_ID_PREFIXES[kind];
	let suffix = "";
	for (let i = 0; i < 8; i++) {
		suffix += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
	}
	return `${prefix}-${suffix}`;
}
