/**
 * Environment variable helpers — corresponds to Python utils/envvar.py
 */

const TRUE_VALUES = new Set(["1", "true", "t", "yes", "y"]);

/**
 * Read an environment variable as a boolean.
 */
export function getEnvBool(name: string, defaultValue = false): boolean {
	const value = process.env[name];
	if (value === undefined) return defaultValue;
	return TRUE_VALUES.has(value.trim().toLowerCase());
}

/**
 * Read an environment variable as an integer.
 */
export function getEnvInt(name: string, defaultValue: number): number {
	const value = process.env[name];
	if (value === undefined) return defaultValue;
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? defaultValue : parsed;
}
