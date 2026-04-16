/**
 * Slash command registry.
 *
 * Central registry for all slash commands (/exit, /help, /yolo, etc.).
 * Commands are registered at startup and looked up when the user
 * submits input starting with `/`.
 */

import type { AppState } from '../app/context.js';
import type { WireClient } from '../wire/index.js';

// ── Types ───────────────────────────────────────────────────────────

export type SlashCommandMode = 'agent' | 'shell' | 'both';

export interface SlashCommandContext {
  wireClient: WireClient;
  appState: AppState;
  setAppState: (patch: Partial<AppState>) => void;
}

export type SlashCommandResult =
  | { type: 'ok'; message?: string }
  | { type: 'reload' }
  | { type: 'exit' };

export interface SlashCommandDef {
  /** Primary name (e.g. "exit"). Without leading slash. */
  name: string;
  /** Alternative names (e.g. ["quit", "q"]). Without leading slash. */
  aliases: string[];
  /** Short description shown in help/menu. */
  description: string;
  /** Which input mode(s) this command is available in. */
  mode: SlashCommandMode;
  /** Execute the command. `args` is the trimmed text after the command name. */
  execute(args: string, ctx: SlashCommandContext): Promise<SlashCommandResult>;
}

// ── Registry ────────────────────────────────────────────────────────

export class SlashCommandRegistry {
  private commands = new Map<string, SlashCommandDef>();
  /** name/alias → def for fast lookup */
  private lookup = new Map<string, SlashCommandDef>();

  /** Register a command definition. */
  register(def: SlashCommandDef): void {
    this.commands.set(def.name, def);
    this.lookup.set(def.name, def);
    for (const alias of def.aliases) {
      this.lookup.set(alias, def);
    }
  }

  /**
   * Find a command by exact name or alias.
   * `input` should be the command name without the leading `/`.
   * Returns null if not found.
   */
  find(input: string): SlashCommandDef | null {
    return this.lookup.get(input) ?? null;
  }

  /**
   * Fuzzy-search commands whose name or alias starts with `prefix`.
   * Used for autocomplete.
   */
  search(prefix: string): SlashCommandDef[] {
    const seen = new Set<string>();
    const results: SlashCommandDef[] = [];

    for (const [key, def] of this.lookup) {
      if (key.startsWith(prefix) && !seen.has(def.name)) {
        seen.add(def.name);
        results.push(def);
      }
    }

    return results.toSorted((a, b) => a.name.localeCompare(b.name));
  }

  /** List all registered commands, optionally filtered by mode. */
  listAll(mode?: SlashCommandMode): SlashCommandDef[] {
    const all = [...this.commands.values()];
    if (mode === undefined) return all.toSorted((a, b) => a.name.localeCompare(b.name));
    return all
      .filter((def) => def.mode === mode || def.mode === 'both')
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  /** Get the number of registered commands. */
  get size(): number {
    return this.commands.size;
  }
}

// ── Parse helper ────────────────────────────────────────────────────

/**
 * Parse a user input string that starts with `/`.
 * Returns the command name and the remaining args, or null if not a slash command.
 */
export function parseSlashInput(input: string): { name: string; args: string } | null {
  if (!input.startsWith('/')) return null;
  const trimmed = input.slice(1).trim();
  if (trimmed.length === 0) return null;
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) {
    return { name: trimmed, args: '' };
  }
  return {
    name: trimmed.slice(0, spaceIdx),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}
