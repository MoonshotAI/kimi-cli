/**
 * `kimi login` sub-command (placeholder).
 */

import type { Command } from 'commander';

export function registerLoginCommand(parent: Command): void {
  parent
    .command('login')
    .description('Login to your Kimi account.')
    .option('--json', 'Emit OAuth events as JSON lines.', false)
    .action((_opts) => {
      // TODO: implement login flow (Phase 10)
      process.stdout.write('kimi login: not yet implemented\n');
    });
}
