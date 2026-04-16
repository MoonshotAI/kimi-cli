/**
 * runLoginFlow — drive an OAuthManager.login() while rendering the
 * DeviceCodeDialog in a standalone Ink instance.
 *
 * Used by bootstrapCoreShell when the configured default provider requires
 * OAuth and has no persisted token. Returns the resolved TokenInfo once the
 * user completes the authorization, or rejects on failure / timeout.
 */

import { execFile } from 'node:child_process';

import { render } from 'ink';
import React from 'react';

import { OAuthError, type OAuthManager, type TokenInfo } from '@moonshot-ai/core';

import DeviceCodeDialog, {
  type DeviceCodeState,
} from '../components/DeviceCodeDialog.js';

export interface LoginFlowOptions {
  readonly providerName: string;
  readonly manager: OAuthManager;
  /** Abort the whole flow (propagated to manager.login()). */
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
  let current: DeviceCodeState = { status: 'requesting' };
  const view = render(
    <DeviceCodeDialog state={current} providerName={options.providerName} />,
  );

  const update = (next: DeviceCodeState): void => {
    current = next;
    view.rerender(
      <DeviceCodeDialog state={current} providerName={options.providerName} />,
    );
  };

  let succeeded = false;

  try {
    const token = await options.manager.login({
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      onDeviceCode: (auth) => {
        openUrl(auth.verificationUriComplete);
        update({
          status: 'pending',
          userCode: auth.userCode,
          verificationUri: auth.verificationUri,
          verificationUriComplete: auth.verificationUriComplete,
        });
      },
    });
    succeeded = true;
    update({ status: 'success' });
    return token;
  } catch (err) {
    const message = err instanceof OAuthError || err instanceof Error ? err.message : String(err);
    update({ status: 'error', message });
    await new Promise<void>((resolve) => { setTimeout(resolve, 1200); });
    throw err;
  } finally {
    if (succeeded) {
      view.unmount();
    } else {
      view.clear();
      view.unmount();
    }
  }
}
