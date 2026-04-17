/**
 * runLoginFlow — pure terminal output version (no React/Ink).
 *
 * Drives an OAuthManager.login() while printing device code instructions
 * to stdout. Used by bootstrapCoreShell when the configured provider
 * requires OAuth and has no persisted token.
 */

import { execFile } from 'node:child_process';

import { OAuthError, type OAuthManager, type TokenInfo } from '@moonshot-ai/core';

export interface LoginFlowOptions {
  readonly providerName: string;
  readonly manager: OAuthManager;
  readonly signal?: AbortSignal | undefined;
}

function openUrl(url: string): void {
  const args =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  execFile(args[0] as string, args[1] as string[], () => {});
}

export async function runLoginFlow(options: LoginFlowOptions): Promise<TokenInfo> {
  process.stdout.write(`\n▶ OAuth login: ${options.providerName}\n`);
  process.stdout.write('Requesting device authorization…\n');

  try {
    const token = await options.manager.login({
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      onDeviceCode: (auth) => {
        openUrl(auth.verificationUriComplete);
        process.stdout.write('\nPlease visit the URL below to authorize this device:\n');
        process.stdout.write(`\n  ${auth.verificationUriComplete}\n\n`);
        process.stdout.write(`Code: ${auth.userCode}\n\n`);
        process.stdout.write('Waiting for authorization… Press Ctrl-C to cancel.\n');
      },
    });
    process.stdout.write('✓ Authorized successfully.\n\n');
    return token;
  } catch (err) {
    const message = err instanceof OAuthError || err instanceof Error ? err.message : String(err);
    process.stderr.write(`✗ ${message}\n\n`);
    await new Promise<void>((resolve) => { setTimeout(resolve, 1200); });
    throw err;
  }
}
