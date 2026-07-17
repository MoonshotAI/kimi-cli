/**
 * Date/time utilities — corresponds to Python utils/datetime.py
 */

/**
 * Format a timestamp as a relative time string.
 */
export function formatRelativeTime(timestamp: number): string {
	const now = Date.now();
	const diffMs = now - timestamp * 1000;

	if (diffMs < 5 * 60 * 1000) {
		return "just now";
	}
	if (diffMs < 60 * 60 * 1000) {
		const minutes = Math.floor(diffMs / (60 * 1000));
		return `${minutes}m ago`;
	}
	if (diffMs < 24 * 60 * 60 * 1000) {
		const hours = Math.floor(diffMs / (60 * 60 * 1000));
		return `${hours}h ago`;
	}
	if (diffMs < 7 * 24 * 60 * 60 * 1000) {
		const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
		return `${days}d ago`;
	}

	const dt = new Date(timestamp * 1000);
	const month = String(dt.getMonth() + 1).padStart(2, "0");
	const day = String(dt.getDate()).padStart(2, "0");
	return `${month}-${day}`;
}

/**
 * Format a duration in seconds using short units.
 */
export function formatDuration(seconds: number): string {
	const parts: string[] = [];
	const days = Math.floor(seconds / 86400);
	if (days) parts.push(`${days}d`);

	const remainder = seconds % 86400;
	const hours = Math.floor(remainder / 3600);
	const minutes = Math.floor((remainder % 3600) / 60);
	const secs = remainder % 60;

	if (hours) parts.push(`${hours}h`);
	if (minutes) parts.push(`${minutes}m`);
	if (secs && parts.length === 0) parts.push(`${secs}s`);

	return parts.join(" ") || "0s";
}
