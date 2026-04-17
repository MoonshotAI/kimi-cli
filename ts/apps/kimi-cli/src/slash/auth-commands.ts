/**
 * OAuth-related slash commands: /login, /logout.
 *
 * These commands are always registered (not gated on OAuth config).
 * They create their own OAuthManager when no pre-wired manager exists,
 * so `/login` works even on a fresh install with no prior OAuth setup.
 */

import { join } from 'node:path';
import { execFile } from 'node:child_process';

import {
  FileTokenStorage,
  KIMI_CODE_FLOW_CONFIG,
  OAuthManager,
  PathConfig,
} from '@moonshot-ai/core';
import type { LoginOptions } from '@moonshot-ai/core';

import type { SlashCommandDef, SlashCommandResult } from './registry.js';

export interface OAuthSlashDeps {
  readonly managers?: Map<
    string,
    {
      logout: () => Promise<void>;
      login: (options?: LoginOptions) => Promise<unknown>;
      hasToken: () => Promise<boolean>;
    }
  >;
  readonly defaultProviderName?: string | undefined;
}

function ok(message: string): SlashCommandResult {
  return { type: 'ok', message };
}

function openUrl(url: string): void {
  const args =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  execFile(args[0] as string, args[1] as string[], () => {});
}

function getDefaultManager(deps: OAuthSlashDeps): {
  logout: () => Promise<void>;
  login: (options?: LoginOptions) => Promise<unknown>;
  hasToken: () => Promise<boolean>;
} {
  const name = deps.defaultProviderName ?? 'managed:kimi-code';
  const existing = deps.managers?.get(name);
  if (existing) return existing;

  const pathConfig = new PathConfig();
  const storage = new FileTokenStorage(join(pathConfig.home, 'credentials'));
  return new OAuthManager({
    config: KIMI_CODE_FLOW_CONFIG,
    storage,
    configDir: pathConfig.home,
    sleep: (ms) => new Promise((r) => { setTimeout(r, Math.min(ms, 1000)); }),
  });
}

export function createAuthCommands(deps: OAuthSlashDeps = {}): SlashCommandDef[] {
  const logoutCommand: SlashCommandDef = {
    name: 'logout',
    aliases: [],
    description: 'Clear OAuth credentials',
    mode: 'both',
    async execute(_args, _ctx) {
      const manager = getDefaultManager(deps);
      const hasToken = await manager.hasToken();
      if (!hasToken) {
        return ok('Not logged in.');
      }
      await manager.logout();
      return ok('Logged out successfully. Restart kimi-cli to re-authenticate.');
    },
  };

  const loginCommand: SlashCommandDef = {
    name: 'login',
    aliases: [],
    description: 'Start OAuth device code login flow',
    mode: 'both',
    async execute(_args, ctx) {
      const manager = getDefaultManager(deps);
      const hasToken = await manager.hasToken();
      if (hasToken) {
        return ok('Already logged in. Use /logout to sign out first.');
      }

      try {
        await manager.login({
          onDeviceCode: (auth) => {
            openUrl(auth.verificationUriComplete);
            ctx.showStatus(
              `Opening browser for authorization…\n\n` +
              `  ${auth.verificationUriComplete}\n\n` +
              `Code: ${auth.userCode}\n\n` +
              `Waiting for authorization…`,
            );
          },
        });
        return { type: 'ok', message: '✓ Login successful!', color: 'green' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return ok(`Login failed: ${message}`);
      }
    },
  };

  return [logoutCommand, loginCommand];
}
