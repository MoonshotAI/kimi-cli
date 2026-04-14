/**
 * `kimi info` sub-command (placeholder).
 */

import type { Command } from 'commander';

export function registerInfoCommand(parent: Command): void {
  parent
    .command('info')
    .description('Show version and protocol information.')
    .option('--json', 'Output as JSON.', false)
    .action((_opts) => {
      // TODO: implement info display (Phase 10)
      process.stdout.write('kimi info: not yet implemented\n');
    });
}
