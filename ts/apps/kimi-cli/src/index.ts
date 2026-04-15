/**
 * kimi-cli entry point.
 *
 * Parses CLI arguments via Commander.js, validates options, determines the
 * UI mode, and dispatches to the appropriate runner (shell / print / wire).
 *
 * In shell mode the Ink 7 TUI is launched with no alternate screen.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import React from 'react';
import { render } from 'ink';
import { MockDataSource } from '@moonshot-ai/kimi-wire-mock';

import { WireClientImpl } from './wire/client.js';
import { createProgram } from './cli/commands.js';
import type { CLIOptions, UIMode } from './cli/options.js';
import { OptionConflictError, validateOptions } from './cli/options.js';
import { loadConfig } from './config/loader.js';
import type { AppState } from './app/context.js';
import App from './app/App.js';

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
// UI mode runners
// ---------------------------------------------------------------------------

function runShell(opts: CLIOptions, version: string): void {
  // Load configuration.
  const { config } = loadConfig({
    config: opts.config,
    configFile: opts.configFile,
  });

  // Determine model name.
  const model = opts.model ?? config.default_model ?? 'mock-model';

  // Determine working directory.
  const workDir = opts.workDir ?? process.cwd();

  // Create MockDataSource and WireClientImpl.
  const dataSource = new MockDataSource();
  const wireClient = new WireClientImpl(dataSource);

  // Create a session.
  const sessionId = dataSource.sessions.create(workDir);

  // Build initial application state.
  const initialState: AppState = {
    inputMode: 'agent',
    model,
    workDir,
    sessionId,
    yolo: opts.yolo,
    planMode: opts.plan,
    thinking: opts.thinking ?? config.default_thinking,
    contextUsage: 0,
    isStreaming: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: config.theme,
    version,
  };

  // Render the Ink TUI -- no alternate screen, patch console, incremental rendering.
  const instance = render(
    React.createElement(App, { wireClient, initialState }),
    {
      exitOnCtrlC: false,
      patchConsole: true,
      incrementalRendering: true,
    },
  );

  void instance.waitUntilExit().then(() => {
    void wireClient.dispose();
    process.exit(0);
  });
}

function runPrint(_opts: CLIOptions): void {
  process.stdout.write('Print mode: not yet implemented (Phase 10)\n');
}

function runWire(_opts: CLIOptions): void {
  process.stdout.write('Wire mode: not yet implemented (Phase 11)\n');
}

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
    switch (uiMode) {
      case 'shell':
        runShell(opts, version);
        break;
      case 'print':
        runPrint(opts);
        break;
      case 'wire':
        runWire(opts);
        break;
    }
  });

  program.parse(process.argv);
}

main();
