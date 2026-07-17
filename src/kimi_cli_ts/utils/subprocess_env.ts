/**
 * Subprocess environment handling — corresponds to Python utils/subprocess_env.py
 *
 * In the Python version, this handles PyInstaller's LD_LIBRARY_PATH modifications.
 * In the Bun/TS version, we don't need PyInstaller handling, but we keep the same
 * interface for compatibility and the non-interactive env setup is still useful.
 */

/**
 * Get a clean environment suitable for spawning subprocesses.
 *
 * In the Bun runtime there's no PyInstaller, so this simply returns a copy
 * of the current environment (or the provided base).
 */
export function getCleanEnv(
	baseEnv?: Record<string, string | undefined>,
): Record<string, string> {
	const env = baseEnv ?? process.env;
	const clean: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) {
			clean[key] = value;
		}
	}
	return clean;
}

/**
 * Get an environment for subprocesses that must not block on interactive prompts.
 *
 * Builds on getCleanEnv and additionally configures git to fail fast instead
 * of waiting for user input that will never arrive.
 */
export function getNoninteractiveEnv(
	baseEnv?: Record<string, string | undefined>,
): Record<string, string> {
	const env = getCleanEnv(baseEnv);

	// GIT_TERMINAL_PROMPT=0 makes git fail instead of prompting for credentials.
	if (!env.GIT_TERMINAL_PROMPT) {
		env.GIT_TERMINAL_PROMPT = "0";
	}

	return env;
}
