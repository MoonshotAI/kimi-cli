/**
 * `kimi logout` sub-command (placeholder).
 */

import type { Command } from 'commander';

export function registerLogoutCommand(parent: Command): void {
  parent
    .command('logout')
    .description('Logout from your Kimi account.')
    .option('--json', 'Emit OAuth events as JSON lines.', false)
    .action((_opts) => {
      // TODO: implement logout flow (Phase 10)
      process.stdout.write('kimi logout: not yet implemented\n');
    });
}
