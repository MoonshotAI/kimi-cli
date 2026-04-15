/**
 * Slash command system -- public API.
 *
 * Creates a pre-populated registry with all built-in commands.
 */

export { SlashCommandRegistry, parseSlashInput } from './registry.js';
export type { SlashCommandDef, SlashCommandContext, SlashCommandResult, SlashCommandMode } from './registry.js';

import { SlashCommandRegistry } from './registry.js';
import { shellCommands } from './shell-commands.js';
import { soulCommands } from './soul-commands.js';

/** Create a registry pre-loaded with all built-in slash commands. */
export function createDefaultRegistry(): SlashCommandRegistry {
  const registry = new SlashCommandRegistry();
  for (const cmd of shellCommands) {
    registry.register(cmd);
  }
  for (const cmd of soulCommands) {
    registry.register(cmd);
  }
  return registry;
}
