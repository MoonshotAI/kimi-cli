/**
 * Device Code OAuth flow — pure HTTP wrappers.
 *
 * Three endpoints, all POST form-encoded to the OAuth host:
 *  - `/api/oauth/device_authorization` → DeviceAuthorization
 *  - `/api/oauth/token` (grant_type=device_code) → polling result
 *  - `/api/oauth/token` (grant_type=refresh_token) → refreshed TokenInfo
 *
 * Matches Python kimi_cli/auth/oauth.py: same paths, same body params, same
 * device header set. No state is kept here — `OAuthManager` drives the flow
 * and decides when to poll / refresh / store.
 */

import {
  OAuthError,
  OAuthUnauthorizedError,
  RetryableRefreshError,
} from './errors.js';
import { getDeviceHeaders } from './device.js';
import type {
  DeviceAuthorization,
  DeviceHeaders,
  OAuthFlowConfig,
  TokenInfo,
} from './types.js';

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickErrorDetail(data: Record<string, unknown>): string {
  if (typeof data['error_description'] === 'string') return data['error_description'];
  if (typeof data['error'] === 'string') return data['error'];
  return 'unknown';
}

function tokenFromResponse(payload: Record<string, unknown>): TokenInfo {
  // M7: required-field validation. Reject responses that are missing
  // any of the three load-bearing fields rather than persisting empty
  // strings that will fail mysteriously later.
  const accessToken = payload['access_token'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new OAuthError('OAuth response missing access_token');
  }
  const refreshToken = payload['refresh_token'];
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new OAuthError('OAuth response missing refresh_token');
  }
  const expiresInRaw = payload['expires_in'];
  const expiresIn = Number(expiresInRaw);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new OAuthError('OAuth response missing or invalid expires_in');
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    scope: typeof payload['scope'] === 'string' ? payload['scope'] : '',
    tokenType: typeof payload['token_type'] === 'string' ? payload['token_type'] : 'Bearer',
    expiresIn,
  };
}

/** M6: HTTP client default timeout. Mirrors Python aiohttp 30s total. */
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

async function postForm(
  url: string,
  params: Record<string, string>,
  deviceHeaders: DeviceHeaders,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<{ status: number; data: Record<string, unknown> }> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const body = new URLSearchParams(params).toString();
  // Compose a timeout signal with the optional caller signal.
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (options?.signal !== undefined) signals.push(options.signal);
  const signal = AbortSignal.any(signals);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        ...deviceHeaders,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal,
    });
  } catch (err) {
    throw new OAuthError(
      `OAuth request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const status = response.status;
  let data: Record<string, unknown> = {};
  try {
    const text = await response.text();
    if (text.length > 0) {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) data = parsed;
    }
  } catch {
    // Non-JSON response — leave data empty; caller interprets by status.
  }
  return { status, data };
}

// ── requestDeviceAuthorization ────────────────────────────────────────

export async function requestDeviceAuthorization(
  config: OAuthFlowConfig,
): Promise<DeviceAuthorization> {
  const url = `${config.oauthHost.replace(/\/$/, '')}/api/oauth/device_authorization`;
  const { status, data } = await postForm(
    url,
    { client_id: config.clientId },
    getDeviceHeaders(),
  );

  if (status !== 200) {
    throw new OAuthError(
      `Device authorization failed (HTTP ${status}): ${pickErrorDetail(data)}`,
    );
  }

  // M7: required-field validation for device authorization response.
  const userCode = data['user_code'];
  const deviceCode = data['device_code'];
  const verificationUriComplete = data['verification_uri_complete'];
  if (typeof userCode !== 'string' || userCode.length === 0) {
    throw new OAuthError('Device authorization response missing user_code');
  }
  if (typeof deviceCode !== 'string' || deviceCode.length === 0) {
    throw new OAuthError('Device authorization response missing device_code');
  }
  if (typeof verificationUriComplete !== 'string' || verificationUriComplete.length === 0) {
    throw new OAuthError(
      'Device authorization response missing verification_uri_complete',
    );
  }

  return {
    userCode,
    deviceCode,
    verificationUri: typeof data['verification_uri'] === 'string' ? data['verification_uri'] : '',
    verificationUriComplete,
    expiresIn: data['expires_in'] !== undefined ? Number(data['expires_in']) : null,
    interval: Number(data['interval'] ?? 5),
  };
}

// ── pollDeviceToken ───────────────────────────────────────────────────

export type DevicePollResult =
  | { readonly kind: 'success'; readonly token: TokenInfo }
  | { readonly kind: 'pending'; readonly errorCode: string; readonly description: string }
  | { readonly kind: 'expired' }
  | { readonly kind: 'denied'; readonly description: string };

export async function pollDeviceToken(
  config: OAuthFlowConfig,
  deviceCode: string,
): Promise<DevicePollResult> {
  const url = `${config.oauthHost.replace(/\/$/, '')}/api/oauth/token`;
  const { status, data } = await postForm(
    url,
    {
      client_id: config.clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    },
    getDeviceHeaders(),
  );

  if (status === 200 && typeof data['access_token'] === 'string') {
    return { kind: 'success', token: tokenFromResponse(data) };
  }

  if (status >= 500) {
    throw new OAuthError(
      `Device token polling server error (HTTP ${status}): ${pickErrorDetail(data)}`,
    );
  }

  const errorCode = typeof data['error'] === 'string' ? data['error'] : 'unknown_error';
  const description = typeof data['error_description'] === 'string' ? data['error_description'] : '';
  switch (errorCode) {
    case 'authorization_pending':
    case 'slow_down':
      return { kind: 'pending', errorCode, description };
    case 'expired_token':
      return { kind: 'expired' };
    case 'access_denied':
      return { kind: 'denied', description };
    default:
      throw new OAuthError(
        `Device token polling failed (HTTP ${status}): ${errorCode} ${description}`,
      );
  }
}

// ── refreshAccessToken ────────────────────────────────────────────────

export interface RefreshOptions {
  readonly maxRetries?: number | undefined;
  /**
   * Backoff between retries in ms. Defaults to `2 ** attempt * 1000` (1s, 2s).
   * Accepts an attempt-indexed callable for testability (set to `() => 0`).
   */
  readonly backoffMs?: ((attempt: number) => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export async function refreshAccessToken(
  config: OAuthFlowConfig,
  refreshToken: string,
  options: RefreshOptions = {},
): Promise<TokenInfo> {
  const maxRetries = options.maxRetries ?? 3;
  const backoff = options.backoffMs ?? ((attempt) => 2 ** attempt * 1000);
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const url = `${config.oauthHost.replace(/\/$/, '')}/api/oauth/token`;

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    let status: number;
    let data: Record<string, unknown>;
    try {
      ({ status, data } = await postForm(
        url,
        {
          client_id: config.clientId,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        },
        getDeviceHeaders(),
      ));
    } catch (err) {
      // Transport-level failure (DNS, connection refused, timeout). Treat
      // as retryable to match Python's `aiohttp.ClientError` handling.
      lastError = err instanceof Error ? err : new OAuthError(String(err));
      if (attempt < maxRetries - 1) {
        await sleep(backoff(attempt));
        continue;
      }
      throw lastError;
    }

    if (status === 200 && typeof data['access_token'] === 'string') {
      return tokenFromResponse(data);
    }

    if (status === 401 || status === 403) {
      throw new OAuthUnauthorizedError(
        typeof data['error_description'] === 'string'
          ? data['error_description']
          : 'Token refresh unauthorized.',
      );
    }

    const desc = typeof data['error_description'] === 'string'
      ? data['error_description']
      : `Token refresh failed (HTTP ${status}).`;
    if (RETRYABLE_STATUSES.has(status)) {
      lastError = new RetryableRefreshError(desc);
      if (attempt < maxRetries - 1) {
        await sleep(backoff(attempt));
        continue;
      }
      // fall through: out of retries, surface the retryable error
    } else {
      throw new OAuthError(desc);
    }
  }

  throw lastError ?? new OAuthError('Token refresh failed after retries.');
}

export type { DeviceHeaders };
