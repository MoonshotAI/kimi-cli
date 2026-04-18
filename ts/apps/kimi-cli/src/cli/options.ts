/**
 * CLI option types and the post-parse validation / normalisation layer.
 *
 * Commander.js parses raw argv into a flat object.  This module defines the
 * canonical shape (`CLIOptions`) and a `validateOptions` function that
 * enforces mutual-exclusion rules, applies implied defaults (e.g. `--quiet`),
 * and determines the UI mode.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UIMode = 'shell' | 'print' | 'wire';
export type InputFormat = 'text' | 'stream-json';
export type OutputFormat = 'text' | 'stream-json';

/**
 * The canonical set of CLI options after Commander.js parsing.
 *
 * Every field maps 1-to-1 to a `--flag` on the main `kimi` command.
 * Optional fields use `undefined` to mean "not provided by the user".
 */
export interface CLIOptions {
  // -- Meta ------------------------------------------------------------------
  verbose: boolean;
  debug: boolean;

  // -- Basic configuration ---------------------------------------------------
  workDir: string | undefined;
  addDir: string[] | undefined;
  session: string | undefined;
  continue: boolean;
  config: string | undefined;
  configFile: string | undefined;
  model: string | undefined;
  /**
   * Treat `--model` as a raw model name if it does not match any
   * configured alias. Off by default — unknown aliases fail fast.
   */
  rawModel: boolean;
  thinking: boolean | undefined;

  // -- Run mode --------------------------------------------------------------
  yolo: boolean;
  plan: boolean;
  prompt: string | undefined;
  print: boolean;
  wire: boolean;
  inputFormat: InputFormat | undefined;
  outputFormat: OutputFormat | undefined;
  finalMessageOnly: boolean;
  quiet: boolean;

  // -- Customisation ---------------------------------------------------------
  agent: string | undefined;
  agentFile: string | undefined;
  mcpConfigFile: string[] | undefined;
  mcpConfig: string[] | undefined;
  skillsDir: string[] | undefined;
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface ValidatedOptions {
  options: CLIOptions;
  uiMode: UIMode;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class OptionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptionConflictError';
  }
}

/**
 * Validate parsed CLI options and determine the UI mode.
 *
 * Mutates `opts` in-place to apply implied defaults (e.g. `--quiet`), then
 * checks mutual-exclusion rules.
 *
 * @throws {OptionConflictError} when mutually exclusive flags are combined.
 */
export function validateOptions(opts: CLIOptions): ValidatedOptions {
  // -- `--quiet` implies `--print --output-format text --final-message-only` -
  if (opts.quiet) {
    if (opts.wire) {
      throw new OptionConflictError('Cannot combine --quiet with --wire.');
    }
    if (opts.outputFormat !== undefined && opts.outputFormat !== 'text') {
      throw new OptionConflictError('--quiet implies --output-format text; cannot override.');
    }
    opts.print = true;
    opts.outputFormat = 'text';
    opts.finalMessageOnly = true;
  }

  // -- Mutual-exclusion checks -----------------------------------------------

  const conflictSets: Record<string, boolean>[] = [
    {
      '--print': opts.print,
      '--wire': opts.wire,
    },
    {
      '--agent': opts.agent !== undefined,
      '--agent-file': opts.agentFile !== undefined,
    },
    {
      '--continue': opts.continue,
      '--session': opts.session !== undefined,
    },
    {
      '--config': opts.config !== undefined,
      '--config-file': opts.configFile !== undefined,
    },
  ];

  for (const set of conflictSets) {
    const active = Object.entries(set)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (active.length > 1) {
      throw new OptionConflictError(`Cannot combine ${active.join(', ')}.`);
    }
  }

  // -- Format-only flags require print mode -----------------------------------
  if (opts.inputFormat !== undefined && !opts.print) {
    throw new OptionConflictError('--input-format is only supported in print mode (--print).');
  }
  if (opts.outputFormat !== undefined && !opts.print) {
    throw new OptionConflictError('--output-format is only supported in print mode (--print).');
  }
  if (opts.finalMessageOnly && !opts.print) {
    throw new OptionConflictError(
      '--final-message-only is only supported in print mode (--print).',
    );
  }

  // -- Determine UI mode ------------------------------------------------------
  let uiMode: UIMode = 'shell';
  if (opts.print) {
    uiMode = 'print';
  } else if (opts.wire) {
    uiMode = 'wire';
  }

  // -- `--session` without an id is only meaningful in shell mode -----------
  //
  // Commander returns `''` (via argParser) when the user passes `--session`,
  // `-S`, or `-r` with no value. That invokes the session picker, which
  // is a TUI-only feature: `--print` / `--wire` have no way to render it,
  // so fail fast with a clear message instead of booting into a dead end.
  if (opts.session === '' && uiMode !== 'shell') {
    throw new OptionConflictError('--session without an id requires shell mode.');
  }

  return { options: opts, uiMode };
}
