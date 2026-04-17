/**
 * Slash command registry.
 *
 * Central registry for all slash commands (/exit, /help, /yolo, etc.).
 * Commands are registered at startup and looked up when the user
 * submits input starting with `/`.
 */

import type { AppState } from '../app/state.js';
import type { WireClient } from '../wire/index.js';

// ── Types ───────────────────────────────────────────────────────────

export type SlashCommandMode = 'agent' | 'shell' | 'both';

export interface SlashCommandContext {
  wireClient: WireClient;
  appState: AppState;
  setAppState: (patch: Partial<AppState>) => void;
  /** Push a status message to the transcript while the command is still running. */
  showStatus: (message: string) => void;
}

export type SlashCommandResult =
  | { type: 'ok'; message?: string; color?: string }
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

// ── Fuzzy matching ──────────────────────────────────────────────────

function fuzzyScore(query: string, target: string): number {
  if (query.length === 0) return 1;
  if (target.startsWith(query)) return 1000 + query.length;

  let qi = 0;
  let score = 0;
  let consecutive = 0;

  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (query[qi] === target[ti]) {
      consecutive++;
      score += consecutive * 2;
      if (ti === 0) score += 5;
      qi++;
    } else {
      consecutive = 0;
    }
  }

  return qi === query.length ? score : 0;
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
   * Fuzzy-search commands whose name or alias matches `prefix`.
   * Supports both prefix matching and fuzzy matching (e.g. "clog" → "changelog").
   * Results are sorted by match quality (prefix matches first, then fuzzy).
   */
  search(prefix: string): SlashCommandDef[] {
    if (prefix.length === 0) return this.listAll();

    const bestScores = new Map<string, { def: SlashCommandDef; score: number }>();

    for (const [key, def] of this.lookup) {
      const s = fuzzyScore(prefix, key);
      if (s > 0) {
        const existing = bestScores.get(def.name);
        if (!existing || s > existing.score) {
          bestScores.set(def.name, { def, score: s });
        }
      }
    }

    return [...bestScores.values()]
      .toSorted((a, b) => b.score - a.score || a.def.name.localeCompare(b.def.name))
      .map(({ def }) => def);
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
