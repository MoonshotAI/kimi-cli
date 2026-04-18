/**
 * `kimi info` sub-command — version + protocol information.
 *
 * Python parity: `kimi_cli.cli.info`. The TS surface adds `nodejs_version`
 * (in place of `python_version`) and `config_path` so users can locate
 * the config file without hunting through `--help`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  SUPPORTED_AGENT_SPEC_VERSIONS,
  WIRE_PROTOCOL_VERSION,
} from '@moonshot-ai/core';
import type { Command } from 'commander';

import { getConfigPath } from '../../config/paths.js';

export interface InfoData {
  readonly kimi_cli_version: string;
  readonly wire_protocol_version: string;
  readonly nodejs_version: string;
  readonly agent_spec_versions: readonly string[];
  readonly config_path: string;
}

export interface InfoDeps {
  readonly getVersion: () => string;
  readonly stdout: { write(chunk: string): boolean };
}

function readPackageVersion(): string {
  // Phase 21 review hotfix — `import.meta.dirname` points at `dist/`
  // after bundling, not at `src/cli/sub/`. The three-levels-up path
  // assumed the source layout and walked off the monorepo root,
  // landing on the top-level package.json (version 0.0.0) instead
  // of the apps/kimi-cli package.json (version 0.0.1). This made
  // `kimi info` and `kimi --version` disagree — the latter uses
  // the same one-level-up resolution via apps/kimi-cli/src/index.ts.
  //
  // Walk candidates so dev (`tsx src/index.ts`) and packaged dist
  // entrypoints both resolve. Dev: dirname = src/cli/sub → ../../..;
  // dist: dirname = dist → ../. We try each in order and take the
  // first match whose manifest actually names this package.
  const candidates = [
    resolve(import.meta.dirname, '..', 'package.json'),
    resolve(import.meta.dirname, '..', '..', 'package.json'),
    resolve(import.meta.dirname, '..', '..', '..', 'package.json'),
  ];
  for (const pkgPath of candidates) {
    try {
      const pkg: { name?: string; version?: string } = JSON.parse(
        readFileSync(pkgPath, 'utf-8'),
      ) as { name?: string; version?: string };
      if (pkg.name === '@moonshot-ai/cli' && typeof pkg.version === 'string') {
        return pkg.version;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return '0.0.0';
}

export function collectInfo(deps: Pick<InfoDeps, 'getVersion'>): InfoData {
  return {
    kimi_cli_version: deps.getVersion(),
    wire_protocol_version: WIRE_PROTOCOL_VERSION,
    nodejs_version: process.version.replace(/^v/, ''),
    agent_spec_versions: SUPPORTED_AGENT_SPEC_VERSIONS,
    config_path: getConfigPath(),
  };
}

export function renderInfoText(info: InfoData): string {
  return (
    [
      `kimi-cli version:    ${info.kimi_cli_version}`,
      `wire protocol:       ${info.wire_protocol_version}`,
      `nodejs version:      ${info.nodejs_version}`,
      `agent spec versions: ${info.agent_spec_versions.join(', ')}`,
      `config:              ${info.config_path}`,
    ].join('\n') + '\n'
  );
}

export function registerInfoCommand(parent: Command, deps?: Partial<InfoDeps>): void {
  const resolved: InfoDeps = {
    getVersion: deps?.getVersion ?? readPackageVersion,
    stdout: deps?.stdout ?? process.stdout,
  };

  parent
    .command('info')
    .description('Show version and protocol information.')
    .option('--json', 'Output as JSON.', false)
    .action((opts: { json?: boolean }) => {
      const info = collectInfo(resolved);
      if (opts.json === true) {
        resolved.stdout.write(JSON.stringify(info) + '\n');
      } else {
        resolved.stdout.write(renderInfoText(info));
      }
    });
}
