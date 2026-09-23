/**
 * Console utilities — corresponds to Python's ui/shell/console.py
 * Terminal size detection and helpers.
 */

/**
 * Get current terminal dimensions.
 */
export function getTerminalSize(): { columns: number; rows: number } {
	return {
		columns: process.stdout.columns || 80,
		rows: process.stdout.rows || 24,
	};
}

/**
 * Listen for terminal resize events.
 */
export function onResize(callback: () => void): () => void {
	process.stdout.on("resize", callback);
	return () => {
		process.stdout.off("resize", callback);
	};
}
