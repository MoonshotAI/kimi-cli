/**
 * Terminal capability detection for DEC 2026 (Synchronized Output).
 *
 * When supported, BSU/ESU sequences tell the terminal to buffer all output
 * between them and paint atomically — preventing visible flicker and
 * preserving text selection during re-renders.
 *
 * Ported from Claude Code's terminal.ts with the same detection logic.
 */

// ── DEC 2026 Sequences ──────────────────────────────────

/** Begin Synchronized Update — terminal buffers subsequent output. */
export const BSU = "\x1b[?2026h";

/** End Synchronized Update — terminal paints buffered output atomically. */
export const ESU = "\x1b[?2026l";

// ── Detection ───────────────────────────────────────────

/**
 * Check if the terminal supports DEC mode 2026 (synchronized output).
 *
 * Detection is based on known terminal programs that implement the protocol.
 * tmux is excluded because it breaks atomicity by chunking writes.
 */
export function isSyncOutputSupported(): boolean {
	// tmux parses and proxies every byte but doesn't implement DEC 2026.
	// BSU/ESU pass through to the outer terminal but tmux has already
	// broken atomicity by chunking. Skip.
	if (process.env.TMUX) return false;

	const termProgram = process.env.TERM_PROGRAM;
	const term = process.env.TERM;

	// Modern terminals with known DEC 2026 support
	if (
		termProgram === "iTerm.app" ||
		termProgram === "WezTerm" ||
		termProgram === "WarpTerminal" ||
		termProgram === "ghostty" ||
		termProgram === "contour" ||
		termProgram === "vscode" ||
		termProgram === "alacritty"
	) {
		return true;
	}

	// kitty sets TERM=xterm-kitty or KITTY_WINDOW_ID
	if (term?.includes("kitty") || process.env.KITTY_WINDOW_ID) return true;

	// Ghostty may set TERM=xterm-ghostty without TERM_PROGRAM
	if (term === "xterm-ghostty") return true;

	// foot sets TERM=foot or TERM=foot-extra
	if (term?.startsWith("foot")) return true;

	// Alacritty may set TERM containing 'alacritty'
	if (term?.includes("alacritty")) return true;

	// Zed uses the alacritty_terminal crate which supports DEC 2026
	if (process.env.ZED_TERM) return true;

	// Windows Terminal
	if (process.env.WT_SESSION) return true;

	// VTE-based terminals (GNOME Terminal, Tilix, etc.) since VTE 0.68
	const vteVersion = process.env.VTE_VERSION;
	if (vteVersion) {
		const version = parseInt(vteVersion, 10);
		if (!isNaN(version) && version >= 6800) return true;
	}

	return false;
}

/** Computed once at module load — terminal capabilities don't change mid-session. */
export const SYNC_SUPPORTED = isSyncOutputSupported();
