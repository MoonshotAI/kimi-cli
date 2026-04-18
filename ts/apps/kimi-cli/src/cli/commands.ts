/**
 * Commander.js program definition.
 *
 * Registers the main `kimi` command with all options, plus sub-command
 * placeholders (login, logout, export, info, mcp).
 */

import { Command, Option } from 'commander';

import type { CLIOptions } from './options.js';
import { registerExportCommand } from './sub/export.js';
import { registerInfoCommand } from './sub/info.js';
import { registerLoginCommand } from './sub/login.js';
import { registerLogoutCommand } from './sub/logout.js';
import { registerMcpCommand } from './sub/mcp.js';

/**
 * Callback invoked when the main `kimi` command runs (i.e. no sub-command).
 *
 * Receives the **merged** CLIOptions after alias resolution.
 */
export type MainCommandHandler = (opts: CLIOptions) => void;

/**
 * Create and configure the top-level Commander program.
 *
 * @param version  - The version string to display for `--version` / `-V`.
 * @param onMain   - Callback for the root command (when no sub-command is given).
 */
export function createProgram(version: string, onMain: MainCommandHandler): Command {
  const program = new Command('kimi')
    .description('Kimi, your next CLI agent.')
    .version(version, '-V, --version')
    .allowUnknownOption(false)
    .configureHelp({ helpWidth: 100 })
    .helpOption('-h, --help', 'Show help.')
    .addHelpText(
      'after',
      '\nDocumentation:        https://moonshotai.github.io/kimi-cli/\n' +
        'LLM friendly version: https://moonshotai.github.io/kimi-cli/llms.txt',
    );

  // ---------------------------------------------------------------------------
  // Meta
  // ---------------------------------------------------------------------------
  program
    .option('--verbose', 'Print verbose information.', false)
    .option('--debug', 'Log debug information.', false);

  // ---------------------------------------------------------------------------
  // Basic configuration
  // ---------------------------------------------------------------------------
  program
    .option('-w, --work-dir <path>', 'Working directory for the agent. Default: current directory.')
    .option(
      '--add-dir <path...>',
      'Add additional directories to the workspace scope (repeatable).',
    )
    .addOption(
      new Option(
        '-S, --session [id]',
        'Resume a session. With ID: resume that session. Without ID: interactively pick.',
      ).argParser((val: string) => val),
    )
    .addOption(
      // -r / --resume is a hidden alias for --session
      new Option('-r, --resume [id]').hideHelp().argParser((val: string) => val),
    )
    .option('-C, --continue', 'Continue the previous session for the working directory.', false)
    .option('--config <toml>', 'Config TOML/JSON string to load.')
    .option('--config-file <path>', 'Config TOML/JSON file to load.')
    .option('-m, --model <name>', 'LLM model to use.')
    .option(
      '--raw-model',
      'Treat --model as a raw model name if it is not a configured alias.',
      false,
    )
    .addOption(new Option('--thinking', 'Enable thinking mode.').conflicts('noThinking'))
    .addOption(new Option('--no-thinking', 'Disable thinking mode.'));

  // ---------------------------------------------------------------------------
  // Run mode
  // ---------------------------------------------------------------------------
  program
    .option('-y, --yolo', 'Automatically approve all actions.', false)
    .addOption(new Option('--yes').hideHelp().default(false))
    .addOption(new Option('--auto-approve').hideHelp().default(false))
    .option('--plan', 'Start in plan mode.', false)
    .option('-p, --prompt <text>', 'User prompt to the agent.')
    .addOption(new Option('-c, --command <text>').hideHelp())
    .option('--print', 'Run in print mode (non-interactive). Implies --yolo.', false)
    .option('--wire', 'Run as Wire server (experimental).', false)
    .addOption(
      new Option('--input-format <format>', 'Input format (print mode only).').choices([
        'text',
        'stream-json',
      ]),
    )
    .addOption(
      new Option('--output-format <format>', 'Output format (print mode only).').choices([
        'text',
        'stream-json',
      ]),
    )
    .option('--final-message-only', 'Only output the final assistant message (print mode).', false)
    .option('--quiet', 'Alias for --print --output-format text --final-message-only.', false);

  // ---------------------------------------------------------------------------
  // Customisation
  // ---------------------------------------------------------------------------
  program
    .addOption(
      new Option('--agent <name>', 'Builtin agent specification.').choices(['default', 'okabe']),
    )
    .option('--agent-file <path>', 'Custom agent specification file.')
    .option('--mcp-config-file <path...>', 'MCP config file to load (repeatable).')
    .option('--mcp-config <json...>', 'MCP config JSON string to load (repeatable).')
    .option('--skills-dir <path...>', 'Custom skills directories (repeatable).');

  // ---------------------------------------------------------------------------
  // Loop control
  // ---------------------------------------------------------------------------
  // Phase 21 Slice C.2.5 — `--max-steps-per-turn`, `--max-retries-per-step`,
  // and `--max-ralph-iterations` are removed in this v1: the TS port has no
  // Ralph loop or per-step retry limit wired in `kimi-core`, so the flags
  // were declared-but-dead. Reintroduce them when (and only when) Ralph mode
  // ships in v1.1+.

  // ---------------------------------------------------------------------------
  // Root command action -- runs when no sub-command is given
  // ---------------------------------------------------------------------------
  program.action(() => {
    const raw = program.opts();

    // Merge aliases: --resume -> session, --yes/--auto-approve -> yolo,
    // --command/-c -> prompt
    const sessionValue = (raw['session'] ?? raw['resume']) as string | undefined;
    const yoloValue = Boolean(raw['yolo'] || raw['yes'] || raw['autoApprove']);
    const promptValue = (raw['prompt'] ?? raw['command']) as string | undefined;

    const opts: CLIOptions = {
      verbose: raw['verbose'] as boolean,
      debug: raw['debug'] as boolean,
      workDir: raw['workDir'] as string | undefined,
      addDir: raw['addDir'] as string[] | undefined,
      session: sessionValue,
      continue: raw['continue'] as boolean,
      config: raw['config'] as string | undefined,
      configFile: raw['configFile'] as string | undefined,
      model: raw['model'] as string | undefined,
      rawModel: Boolean(raw['rawModel']),
      thinking: raw['thinking'] as boolean | undefined,
      yolo: yoloValue,
      plan: raw['plan'] as boolean,
      prompt: promptValue,
      print: raw['print'] as boolean,
      wire: raw['wire'] as boolean,
      inputFormat: raw['inputFormat'] as CLIOptions['inputFormat'],
      outputFormat: raw['outputFormat'] as CLIOptions['outputFormat'],
      finalMessageOnly: raw['finalMessageOnly'] as boolean,
      quiet: raw['quiet'] as boolean,
      agent: raw['agent'] as string | undefined,
      agentFile: raw['agentFile'] as string | undefined,
      mcpConfigFile: raw['mcpConfigFile'] as string[] | undefined,
      mcpConfig: raw['mcpConfig'] as string[] | undefined,
      skillsDir: raw['skillsDir'] as string[] | undefined,
    };

    onMain(opts);
  });

  // ---------------------------------------------------------------------------
  // Sub-commands (placeholder implementations)
  // ---------------------------------------------------------------------------
  registerLoginCommand(program);
  registerLogoutCommand(program);
  registerExportCommand(program);
  registerInfoCommand(program);
  registerMcpCommand(program);

  return program;
}
