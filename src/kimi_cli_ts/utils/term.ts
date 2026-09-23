/**
 * Terminal utilities — corresponds to Python utils/term.py
 * Cursor position detection and terminal state management.
 */

/**
 * Ensure the next prompt starts at column 0 regardless of prior command output.
 *
 * Note: In the TS/Bun version with React Ink, this is less commonly needed
 * as Ink manages terminal state. Kept for CLI/print mode compatibility.
 */
export function ensureNewLine(): void {
	if (!process.stdout.isTTY || !process.stdin.isTTY) return;
	// In Bun, we can't easily query cursor position synchronously like Python does
	// with termios. Write a newline as a safe fallback.
	process.stdout.write("\n");
}

/**
 * Get the terminal size (columns, rows).
 */
export function getTerminalSize(): { columns: number; rows: number } {
	return {
		columns: process.stdout.columns ?? 80,
		rows: process.stdout.rows ?? 24,
	};
}
