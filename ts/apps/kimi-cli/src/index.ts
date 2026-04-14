/**
 * kimi-cli entry point.
 *
 * Parses CLI arguments via Commander.js, validates options, determines the
 * UI mode, and dispatches to the appropriate runner (shell / print / wire).
 *
 * Runner implementations are placeholders until later phases.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProgram } from './cli/commands.js';
import type { CLIOptions, UIMode } from './cli/options.js';
import { OptionConflictError, validateOptions } from './cli/options.js';

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

function getVersion(): string {
  // In the built bundle the dist/ directory sits one level below the package
  // root, so package.json is at `../package.json`.  During development with
  // tsx the source file is at `src/`, same relative depth.
  const pkgPath = resolve(__dirname, '..', 'package.json');
  const pkg: { version: string } = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  return pkg.version;
}

// ---------------------------------------------------------------------------
// UI mode runners (placeholders -- will be implemented in later phases)
// ---------------------------------------------------------------------------

function runShell(_opts: CLIOptions): void {
  process.stdout.write('Shell mode: not yet implemented (Phase 4+)\n');
}

function runPrint(_opts: CLIOptions): void {
  process.stdout.write('Print mode: not yet implemented (Phase 10)\n');
}

function runWire(_opts: CLIOptions): void {
  process.stdout.write('Wire mode: not yet implemented (Phase 11)\n');
}

const runners: Record<UIMode, (opts: CLIOptions) => void> = {
  shell: runShell,
  print: runPrint,
  wire: runWire,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const version = getVersion();

  const program = createProgram(version, (opts) => {
    // -- Validate and resolve UI mode ----------------------------------------
    let uiMode: UIMode;
    try {
      const result = validateOptions(opts);
      uiMode = result.uiMode;
    } catch (err) {
      if (err instanceof OptionConflictError) {
        process.stderr.write(`error: ${err.message}\n`);
        process.exit(1);
      }
      throw err;
    }

    // -- Dispatch to the appropriate runner ----------------------------------
    runners[uiMode](opts);
  });

  program.parse(process.argv);
}

main();
