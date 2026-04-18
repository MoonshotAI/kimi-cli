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
  try {
    const pkgPath = resolve(import.meta.dirname, '..', '..', '..', 'package.json');
    const pkg: { version?: string } = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
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
