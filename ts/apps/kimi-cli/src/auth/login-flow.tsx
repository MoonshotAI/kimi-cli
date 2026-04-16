/**
 * runLoginFlow — drive an OAuthManager.login() while rendering the
 * DeviceCodeDialog in a standalone Ink instance.
 *
 * Used by bootstrapCoreShell when the configured default provider requires
 * OAuth and has no persisted token. Returns the resolved TokenInfo once the
 * user completes the authorization, or rejects on failure / timeout.
 */

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

  try {
    const token = await options.manager.login({
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      onDeviceCode: (auth) => {
        update({
          status: 'pending',
          userCode: auth.userCode,
          verificationUri: auth.verificationUri,
          verificationUriComplete: auth.verificationUriComplete,
          intervalSeconds: auth.interval,
        });
      },
    });
    update({ status: 'success' });
    // Hold the success state for ~600ms so the user registers the transition.
    await new Promise<void>((resolve) => { setTimeout(resolve, 600); });
    return token;
  } catch (err) {
    const message = err instanceof OAuthError || err instanceof Error ? err.message : String(err);
    update({ status: 'error', message });
    await new Promise<void>((resolve) => { setTimeout(resolve, 1200); });
    throw err;
  } finally {
    // Ink's `clear()` wipes the rendered output using the still-live output
    // stream; `unmount()` releases it. Calling them in reverse order can
    // throw on some terminals because `clear()` would target a disposed
    // stream.
    view.clear();
    view.unmount();
  }
}
