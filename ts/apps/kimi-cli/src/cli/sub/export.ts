/**
 * `kimi export` sub-command (placeholder).
 */

import type { Command } from 'commander';

export function registerExportCommand(parent: Command): void {
  parent
    .command('export')
    .description('Export a session as a ZIP archive.')
    .argument('[session-id]', 'Session ID to export.')
    .option('-o, --output <path>', 'Output file path.')
    .option('-y, --yes', 'Overwrite without confirmation.', false)
    .action((_sessionId, _opts) => {
      // TODO: implement export (Phase 10)
      process.stdout.write('kimi export: not yet implemented\n');
    });
}
