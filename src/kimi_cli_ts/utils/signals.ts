/**
 * Signal handling utilities — corresponds to Python utils/signals.py
 * Cross-platform SIGINT handler installation.
 */

/**
 * Install a SIGINT handler. Returns a function to remove it.
 *
 * Works on Unix and Windows (Bun's process.on is cross-platform).
 */
export function installSigintHandler(handler: () => void): () => void {
	const listener = () => handler();
	process.on("SIGINT", listener);

	return () => {
		process.off("SIGINT", listener);
	};
}

/**
 * Install a SIGTERM handler. Returns a function to remove it.
 */
export function installSigtermHandler(handler: () => void): () => void {
	const listener = () => handler();
	process.on("SIGTERM", listener);

	return () => {
		process.off("SIGTERM", listener);
	};
}

/**
 * Install handlers for graceful shutdown on both SIGINT and SIGTERM.
 * Returns a function to remove all handlers.
 */
export function installShutdownHandlers(handler: () => void): () => void {
	const removeSigint = installSigintHandler(handler);
	const removeSigterm = installSigtermHandler(handler);

	return () => {
		removeSigint();
		removeSigterm();
	};
}
