/**
 * `kimi login` sub-command — OAuth Device Code Flow.
 *
 * Non-JSON mode renders the DeviceCodeDialog via Ink (same as bootstrap).
 * JSON mode emits one JSON line per event for scripting / CI use.
 */

import { join } from 'node:path';

import type { Command } from 'commander';
import {
  FileTokenStorage,
  KIMI_CODE_FLOW_CONFIG,
  OAuthError,
  OAuthManager,
  PathConfig,
} from '@moonshot-ai/core';

import { runLoginFlow } from '../../auth/login-flow-tui.js';

export function registerLoginCommand(parent: Command): void {
  parent
    .command('login')
    .description('Login to your Kimi account.')
    .option('--json', 'Emit OAuth events as JSON lines.', false)
    .action(async (opts: { json: boolean }) => {
      const pathConfig = new PathConfig();
      const storage = new FileTokenStorage(join(pathConfig.home, 'credentials'));
      const manager = new OAuthManager({
        config: KIMI_CODE_FLOW_CONFIG,
        storage,
        sleep: (ms) => new Promise((r) => { setTimeout(r, Math.min(ms, 1000)); }),
      });

      const hasToken = await manager.hasToken();
      if (hasToken) {
        if (opts.json) {
          process.stdout.write(JSON.stringify({ event: 'already_logged_in' }) + '\n');
        } else {
          process.stdout.write('Already logged in. Use `kimi logout` to sign out first.\n');
        }
        process.exit(0);
      }

      if (opts.json) {
        await runJsonLoginFlow(manager);
      } else {
        await runInteractiveLoginFlow(manager);
      }
    });
}

async function runInteractiveLoginFlow(manager: OAuthManager): Promise<void> {
  try {
    await runLoginFlow({
      providerName: KIMI_CODE_FLOW_CONFIG.name,
      manager,
    });
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Login failed: ${message}\n`);
    process.exit(1);
  }
}

async function runJsonLoginFlow(manager: OAuthManager): Promise<void> {
  const emit = (obj: Record<string, unknown>): void => {
    process.stdout.write(JSON.stringify(obj) + '\n');
  };

  try {
    await manager.login({
      onDeviceCode: (auth) => {
        emit({
          event: 'device_code',
          user_code: auth.userCode,
          verification_uri: auth.verificationUri,
          verification_uri_complete: auth.verificationUriComplete,
        });
      },
    });
    emit({ event: 'login_success' });
    process.exit(0);
  } catch (err) {
    const message = err instanceof OAuthError || err instanceof Error ? err.message : String(err);
    emit({ event: 'login_error', message });
    process.exit(1);
  }
}
