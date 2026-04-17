/**
 * Slash command system -- public API.
 *
 * Creates a pre-populated registry with all built-in commands.
 */

export { SlashCommandRegistry, parseSlashInput } from './registry.js';
export type {
  SlashCommandDef,
  SlashCommandContext,
  SlashCommandResult,
  SlashCommandMode,
  ReloadAction,
} from './registry.js';

import { SlashCommandRegistry } from './registry.js';
import { createAuthCommands } from './auth-commands.js';
import type { OAuthSlashDeps } from './auth-commands.js';
import { shellCommands } from './shell-commands.js';
import { soulCommands } from './soul-commands.js';

/** Create a registry pre-loaded with all built-in slash commands. */
export function createDefaultRegistry(authDeps?: OAuthSlashDeps): SlashCommandRegistry {
  const registry = new SlashCommandRegistry();
  for (const cmd of shellCommands) {
    registry.register(cmd);
  }
  for (const cmd of soulCommands) {
    registry.register(cmd);
  }
  for (const cmd of createAuthCommands(authDeps)) {
    registry.register(cmd);
  }
  return registry;
}
