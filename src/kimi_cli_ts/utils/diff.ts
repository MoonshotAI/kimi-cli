/**
 * Diff utilities — corresponds to Python utils/diff.py
 * Unified diff formatting and diff block generation.
 */

const N_CONTEXT_LINES = 3;
const HUGE_FILE_THRESHOLD = 10000;

/**
 * Format a unified diff between old_text and new_text.
 */
export function formatUnifiedDiff(
	oldText: string,
	newText: string,
	path = "",
	opts?: { includeFileHeader?: boolean },
): string {
	const includeFileHeader = opts?.includeFileHeader ?? true;
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");

	const fromFile = path ? `a/${path}` : "a/file";
	const toFile = path ? `b/${path}` : "b/file";

	// Simple unified diff implementation
	const hunks = computeHunks(oldLines, newLines, N_CONTEXT_LINES);
	if (hunks.length === 0) return "";

	const result: string[] = [];
	if (includeFileHeader) {
		result.push(`--- ${fromFile}`);
		result.push(`+++ ${toFile}`);
	}

	for (const hunk of hunks) {
		result.push(hunk);
	}

	return result.join("\n") + "\n";
}

function computeHunks(
	oldLines: string[],
	newLines: string[],
	context: number,
): string[] {
	// LCS-based diff
	const ops = diffLines(oldLines, newLines);
	if (ops.length === 0) return [];

	const hunks: string[] = [];
	let i = 0;

	while (i < ops.length) {
		// Find next change
		while (i < ops.length && ops[i] === "equal") i++;
		if (i >= ops.length) break;

		// Determine hunk boundaries
		const changeStart = i;
		let changeEnd = i;
		while (changeEnd < ops.length) {
			if (ops[changeEnd] === "equal") {
				// Check if there's another change within context
				let nextChange = changeEnd;
				while (nextChange < ops.length && ops[nextChange] === "equal")
					nextChange++;
				if (nextChange >= ops.length || nextChange - changeEnd > context * 2)
					break;
				changeEnd = nextChange;
			}
			changeEnd++;
		}

		// Build hunk with context
		const start = Math.max(0, changeStart - context);
		const end = Math.min(ops.length, changeEnd + context);

		let oldStart = 0;
		let newStart = 0;
		for (let j = 0; j < start; j++) {
			if (ops[j] === "equal" || ops[j] === "delete") oldStart++;
			if (ops[j] === "equal" || ops[j] === "insert") newStart++;
		}

		let oldCount = 0;
		let newCount = 0;
		const lines: string[] = [];

		let oldIdx = oldStart;
		let newIdx = newStart;
		for (let j = start; j < end; j++) {
			const op = ops[j]!;
			if (op === "equal") {
				lines.push(` ${oldLines[oldIdx] ?? ""}`);
				oldIdx++;
				newIdx++;
				oldCount++;
				newCount++;
			} else if (op === "delete") {
				lines.push(`-${oldLines[oldIdx] ?? ""}`);
				oldIdx++;
				oldCount++;
			} else if (op === "insert") {
				lines.push(`+${newLines[newIdx] ?? ""}`);
				newIdx++;
				newCount++;
			}
		}

		hunks.push(
			`@@ -${oldStart + 1},${oldCount} +${newStart + 1},${newCount} @@`,
		);
		hunks.push(...lines);

		i = changeEnd;
	}

	return hunks;
}

function diffLines(
	oldLines: string[],
	newLines: string[],
): ("equal" | "delete" | "insert")[] {
	const m = oldLines.length;
	const n = newLines.length;

	if (m === 0 && n === 0) return [];
	if (m === 0) return new Array(n).fill("insert");
	if (n === 0) return new Array(m).fill("delete");

	// Myers diff algorithm (simplified)
	const max = m + n;
	const v = new Array(2 * max + 1).fill(0);
	const trace: number[][] = [];

	outer: for (let d = 0; d <= max; d++) {
		trace.push([...v]);
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && v[k - 1 + max]! < v[k + 1 + max]!)) {
				x = v[k + 1 + max]!;
			} else {
				x = v[k - 1 + max]! + 1;
			}
			let y = x - k;
			while (x < m && y < n && oldLines[x] === newLines[y]) {
				x++;
				y++;
			}
			v[k + max] = x;
			if (x >= m && y >= n) break outer;
		}
	}

	// Backtrack to build edit script
	const ops: ("equal" | "delete" | "insert")[] = [];
	let x = m;
	let y = n;

	for (let d = trace.length - 1; d > 0; d--) {
		const prev = trace[d - 1]!;
		const k = x - y;
		let prevK: number;
		if (k === -d || (k !== d && prev[k - 1 + max]! < prev[k + 1 + max]!)) {
			prevK = k + 1;
		} else {
			prevK = k - 1;
		}
		const prevX = prev[prevK + max]!;
		const prevY = prevX - prevK;

		// Diagonal moves (equal)
		while (x > prevX + (prevK < k ? 1 : 0) && y > prevY + (prevK < k ? 0 : 1)) {
			ops.push("equal");
			x--;
			y--;
		}

		if (prevK < k) {
			ops.push("delete");
			x--;
		} else {
			ops.push("insert");
			y--;
		}
	}

	// Remaining diagonal
	while (x > 0 && y > 0 && oldLines[x - 1] === newLines[y - 1]) {
		ops.push("equal");
		x--;
		y--;
	}

	ops.reverse();
	return ops;
}

export interface DiffBlock {
	path: string;
	oldText: string;
	newText: string;
	oldStart: number;
	newStart: number;
	isSummary?: boolean;
}

/**
 * Build diff display blocks grouped with small context windows.
 */
export function buildDiffBlocks(
	path: string,
	oldText: string,
	newText: string,
): DiffBlock[] {
	if (oldText === newText) return [];

	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const maxLines = Math.max(oldLines.length, newLines.length);

	// Huge files: skip diff entirely
	if (maxLines > HUGE_FILE_THRESHOLD) {
		const oldDesc = `(${oldLines.length} lines)`;
		const newDesc =
			oldLines.length === newLines.length
				? `(${newLines.length} lines, modified)`
				: `(${newLines.length} lines)`;
		return [
			{
				path,
				oldText: oldDesc,
				newText: newDesc,
				oldStart: 1,
				newStart: 1,
				isSummary: true,
			},
		];
	}

	// Use simple sequence matching for blocks
	const blocks: DiffBlock[] = [];
	const ops = diffLines(oldLines, newLines);

	let i = 0;
	while (i < ops.length) {
		// Skip equal ops
		while (i < ops.length && ops[i] === "equal") i++;
		if (i >= ops.length) break;

		// Find change range
		const changeStart = i;
		let changeEnd = i;
		while (changeEnd < ops.length) {
			if (ops[changeEnd] === "equal") {
				let nextChange = changeEnd;
				while (nextChange < ops.length && ops[nextChange] === "equal")
					nextChange++;
				if (
					nextChange >= ops.length ||
					nextChange - changeEnd > N_CONTEXT_LINES * 2
				)
					break;
				changeEnd = nextChange;
			}
			changeEnd++;
		}

		const start = Math.max(0, changeStart - N_CONTEXT_LINES);
		const end = Math.min(ops.length, changeEnd + N_CONTEXT_LINES);

		let oldIdx = 0;
		let newIdx = 0;
		for (let j = 0; j < start; j++) {
			if (ops[j] === "equal" || ops[j] === "delete") oldIdx++;
			if (ops[j] === "equal" || ops[j] === "insert") newIdx++;
		}

		const oldStart = oldIdx;
		const newStart = newIdx;
		const blockOldLines: string[] = [];
		const blockNewLines: string[] = [];

		for (let j = start; j < end; j++) {
			const op = ops[j]!;
			if (op === "equal") {
				blockOldLines.push(oldLines[oldIdx]!);
				blockNewLines.push(newLines[newIdx]!);
				oldIdx++;
				newIdx++;
			} else if (op === "delete") {
				blockOldLines.push(oldLines[oldIdx]!);
				oldIdx++;
			} else {
				blockNewLines.push(newLines[newIdx]!);
				newIdx++;
			}
		}

		blocks.push({
			path,
			oldText: blockOldLines.join("\n"),
			newText: blockNewLines.join("\n"),
			oldStart: oldStart + 1,
			newStart: newStart + 1,
		});

		i = changeEnd;
	}

	return blocks;
}

/**
 * Wire-compatible diff display block (snake_case fields matching wire/types.ts DiffDisplayBlock).
 */
export interface WireDiffDisplayBlock {
	type: "diff";
	path: string;
	old_text: string;
	new_text: string;
	old_start: number;
	new_start: number;
	is_summary: boolean;
}

/**
 * Build wire-compatible diff display blocks for approval and tool result display.
 * Returns objects matching the wire DiffDisplayBlock schema (snake_case).
 */
export function buildWireDiffBlocks(
	path: string,
	oldText: string,
	newText: string,
): WireDiffDisplayBlock[] {
	const blocks = buildDiffBlocks(path, oldText, newText);
	return blocks.map((b) => ({
		type: "diff" as const,
		path: b.path,
		old_text: b.oldText,
		new_text: b.newText,
		old_start: b.oldStart,
		new_start: b.newStart,
		is_summary: b.isSummary ?? false,
	}));
}
