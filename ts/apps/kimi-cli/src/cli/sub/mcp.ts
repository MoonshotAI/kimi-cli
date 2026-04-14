/**
 * `kimi mcp` sub-command group (placeholder).
 */

import type { Command } from 'commander';

export function registerMcpCommand(parent: Command): void {
  const mcp = parent
    .command('mcp')
    .description('Manage MCP servers.');

  mcp
    .command('add')
    .description('Add an MCP server.')
    .action(() => {
      process.stdout.write('kimi mcp add: not yet implemented\n');
    });

  mcp
    .command('remove')
    .description('Remove an MCP server.')
    .argument('<name>', 'Server name to remove.')
    .action((_name) => {
      process.stdout.write('kimi mcp remove: not yet implemented\n');
    });

  mcp
    .command('list')
    .description('List all MCP servers.')
    .action(() => {
      process.stdout.write('kimi mcp list: not yet implemented\n');
    });

  mcp
    .command('auth')
    .description('OAuth authenticate an MCP server.')
    .argument('<name>', 'Server name to authenticate.')
    .action((_name) => {
      process.stdout.write('kimi mcp auth: not yet implemented\n');
    });

  mcp
    .command('reset-auth')
    .description('Reset OAuth authentication for an MCP server.')
    .argument('<name>', 'Server name to reset.')
    .action((_name) => {
      process.stdout.write('kimi mcp reset-auth: not yet implemented\n');
    });

  mcp
    .command('test')
    .description('Test MCP server connection.')
    .argument('<name>', 'Server name to test.')
    .action((_name) => {
      process.stdout.write('kimi mcp test: not yet implemented\n');
    });
}
