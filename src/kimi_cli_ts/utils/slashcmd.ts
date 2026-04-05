/**
 * Slash command parsing — corresponds to Python utils/slashcmd.py
 * Provides SlashCommand, SlashCommandRegistry, and parse utilities.
 */

// ── SlashCommand ──────────────────────────────────────────

export interface SlashCommand<
	F extends (...args: never[]) => unknown = (...args: never[]) => unknown,
> {
	readonly name: string;
	readonly description: string;
	readonly func: F;
	readonly aliases: string[];
}

export function slashName(cmd: SlashCommand): string {
	if (cmd.aliases.length > 0) {
		return `/${cmd.name} (${cmd.aliases.join(", ")})`;
	}
	return `/${cmd.name}`;
}

// ── SlashCommandRegistry ──────────────────────────────────

export class SlashCommandRegistry<
	F extends (...args: never[]) => unknown = (...args: never[]) => unknown,
> {
	private _commands = new Map<string, SlashCommand<F>>();
	private _commandAliases = new Map<string, SlashCommand<F>>();

	/**
	 * Register a slash command.
	 */
	register(
		func: F,
		options?: { name?: string; aliases?: string[]; description?: string },
	): void {
		const name = options?.name ?? func.name;
		const aliases = options?.aliases ?? [];
		const description = options?.description ?? "";

		const cmd: SlashCommand<F> = { name, description, func, aliases };

		this._commands.set(name, cmd);
		this._commandAliases.set(name, cmd);

		for (const alias of aliases) {
			this._commandAliases.set(alias, cmd);
		}
	}

	findCommand(name: string): SlashCommand<F> | null {
		return this._commandAliases.get(name) ?? null;
	}

	listCommands(): SlashCommand<F>[] {
		return Array.from(this._commands.values());
	}
}

// ── SlashCommandCall ──────────────────────────────────────

export interface SlashCommandCall {
	readonly name: string;
	readonly args: string;
	readonly rawInput: string;
}

const SLASH_CMD_RE = /^\/([a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*)/;

/**
 * Parse a slash command call from user input.
 * Returns null if no slash command is found.
 */
export function parseSlashCommandCall(
	userInput: string,
): SlashCommandCall | null {
	const trimmed = userInput.trim();
	if (!trimmed || !trimmed.startsWith("/")) return null;

	const match = SLASH_CMD_RE.exec(trimmed);
	if (!match) return null;

	const commandName = match[1]!;
	if (
		trimmed.length > match[0].length &&
		!/\s/.test(trimmed[match[0].length]!)
	) {
		return null;
	}

	const rawArgs = trimmed.slice(match[0].length).trimStart();
	return { name: commandName, args: rawArgs, rawInput: trimmed };
}
