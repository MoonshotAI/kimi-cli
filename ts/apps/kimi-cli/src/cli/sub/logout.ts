/**
 * `kimi logout` sub-command — clear persisted OAuth credentials.
 */

import { join } from 'node:path';

import type { Command } from 'commander';
import {
  FileTokenStorage,
  KIMI_CODE_FLOW_CONFIG,
  OAuthManager,
  PathConfig,
} from '@moonshot-ai/core';

export function registerLogoutCommand(parent: Command): void {
  parent
    .command('logout')
    .description('Logout from your Kimi account.')
    .option('--json', 'Emit OAuth events as JSON lines.', false)
    .action(async (opts: { json: boolean }) => {
      const pathConfig = new PathConfig();
      const storage = new FileTokenStorage(join(pathConfig.home, 'credentials'));
      const manager = new OAuthManager({
        config: KIMI_CODE_FLOW_CONFIG,
        storage,
        configDir: pathConfig.home,
      });

      const hasToken = await manager.hasToken();
      if (!hasToken) {
        if (opts.json) {
          process.stdout.write(JSON.stringify({ event: 'not_logged_in' }) + '\n');
        } else {
          process.stdout.write('Not logged in.\n');
        }
        process.exit(0);
      }

      await manager.logout();

      if (opts.json) {
        process.stdout.write(JSON.stringify({ event: 'logged_out' }) + '\n');
      } else {
        process.stdout.write('Logged out successfully.\n');
      }
      process.exit(0);
    });
}
