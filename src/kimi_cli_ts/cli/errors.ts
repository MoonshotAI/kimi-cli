/**
 * CLI error types — extracted from cli/index.ts to break circular imports.
 *
 * These sentinel errors are thrown by soul/kimisoul.ts and caught by cli/index.ts.
 * Keeping them in a separate leaf module avoids the cycle:
 *   cli/index.ts → app.ts → soul/kimisoul.ts → cli/index.ts
 */

export class Reload extends Error {
	sessionId: string | null;
	prefillText: string | null;
	constructor(
		sessionId: string | null = null,
		prefillText: string | null = null,
	) {
		super("reload");
		this.name = "Reload";
		this.sessionId = sessionId;
		this.prefillText = prefillText;
	}
}

/** Return true if an unknown value is a Reload sentinel. */
export function isReload(err: unknown): err is Reload {
	return (
		err instanceof Reload || (err instanceof Error && err.name === "Reload")
	);
}

export class SwitchToWeb extends Error {
	sessionId: string | null;
	constructor(sessionId: string | null = null) {
		super("switch_to_web");
		this.name = "SwitchToWeb";
		this.sessionId = sessionId;
	}
}

export class SwitchToVis extends Error {
	sessionId: string | null;
	constructor(sessionId: string | null = null) {
		super("switch_to_vis");
		this.name = "SwitchToVis";
		this.sessionId = sessionId;
	}
}
