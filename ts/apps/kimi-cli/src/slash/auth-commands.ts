/**
 * OAuth-related slash commands: /login, /logout.
 *
 * MVP semantics:
 *  - `/logout`: clear the stored token; next LLM call will fail until re-login.
 *    Restart the CLI for a clean login flow.
 *  - `/login`: in-session login is NOT supported in Slice 5.0 MVP. The
 *    command prints a guidance message. Full in-session relogin is tracked
 *    as a Phase 5.x follow-up.
 *
 * Both commands need access to the OAuthManager. We attach it onto the
 * SlashCommandContext via `appState.wireClient` -> casting is ugly, so
 * instead we expose a separate registration helper that binds the manager.
 */

import type { SlashCommandDef, SlashCommandResult } from './registry.js';

export interface OAuthSlashDeps {
  /** Map provider name → OAuthManager. Omit names to disable /login for them. */
  readonly managers: Map<string, { logout: () => Promise<void> }>;
  /** Provider name shown in messages (e.g. "kimi-code"). */
  readonly defaultProviderName?: string | undefined;
}

function ok(message: string): SlashCommandResult {
  return { type: 'ok', message };
}

export function createAuthCommands(deps: OAuthSlashDeps): SlashCommandDef[] {
  const logoutCommand: SlashCommandDef = {
    name: 'logout',
    aliases: [],
    description: 'Clear OAuth credentials (restart required to re-login)',
    mode: 'both',
    async execute(args, _ctx) {
      const name = args.trim() || deps.defaultProviderName;
      if (!name) {
        const available = [...deps.managers.keys()];
        if (available.length === 0) {
          return ok('No OAuth providers configured.');
        }
        return ok(
          `Usage: /logout <provider>. Available: ${available.join(', ')}`,
        );
      }
      const manager = deps.managers.get(name);
      if (!manager) {
        return ok(`Unknown OAuth provider: ${name}`);
      }
      await manager.logout();
      return ok(
        `Logged out of "${name}". Restart kimi-cli to re-authenticate.`,
      );
    },
  };

  const loginCommand: SlashCommandDef = {
    name: 'login',
    aliases: [],
    description: 'Show OAuth login guidance (full in-session login is a future feature)',
    mode: 'both',
    async execute(_args, _ctx) {
      return ok(
        'In-session /login is not yet available.\n' +
        'To re-authenticate: run /logout, then restart kimi-cli.',
      );
    },
  };

  return [logoutCommand, loginCommand];
}
