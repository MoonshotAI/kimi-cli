/**
 * OAuth type definitions for managed providers.
 *
 * Only Device Code Flow (RFC 8628) is supported — the same flow Python
 * kimi_cli/auth/oauth.py uses against https://auth.kimi.com.
 *
 * Wire format (on disk / server) stays snake_case to match Python tokens;
 * in-process types use camelCase per TS convention.
 */

export type OAuthStorageBackend = 'file';

/** A persisted OAuth token bundle. */
export interface TokenInfo {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Unix seconds when access_token expires. */
  readonly expiresAt: number;
  readonly scope: string;
  readonly tokenType: string;
  /** Original expires_in from server response (seconds). */
  readonly expiresIn: number;
}

/** RFC 8628 §3.2 device authorization response. */
export interface DeviceAuthorization {
  readonly userCode: string;
  readonly deviceCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  /** Seconds until device_code expires (server-reported). May be null. */
  readonly expiresIn: number | null;
  /** Polling interval in seconds. */
  readonly interval: number;
}

/** OAuth flow endpoint + client configuration. */
export interface OAuthFlowConfig {
  /** Logical provider name for storage (e.g. "kimi-code"). */
  readonly name: string;
  /** Base URL of the OAuth server, no trailing slash. */
  readonly oauthHost: string;
  /** Client ID registered with the OAuth provider. */
  readonly clientId: string;
}

/** Device identification for `X-Msh-*` headers. */
export interface DeviceHeaders {
  readonly 'X-Msh-Platform': string;
  readonly 'X-Msh-Version': string;
  readonly 'X-Msh-Device-Name': string;
  readonly 'X-Msh-Device-Model': string;
  readonly 'X-Msh-Os-Version': string;
  readonly 'X-Msh-Device-Id': string;
}

/** JSON wire format for token persistence (snake_case, Python-compatible). */
export interface TokenInfoWire {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: number;
  readonly scope: string;
  readonly token_type: string;
  readonly expires_in: number;
}

export function tokenToWire(token: TokenInfo): TokenInfoWire {
  return {
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expires_at: token.expiresAt,
    scope: token.scope,
    token_type: token.tokenType,
    expires_in: token.expiresIn,
  };
}

export function tokenFromWire(wire: Partial<TokenInfoWire>): TokenInfo {
  return {
    accessToken: String(wire.access_token ?? ''),
    refreshToken: String(wire.refresh_token ?? ''),
    expiresAt: typeof wire.expires_at === 'number' ? wire.expires_at : 0,
    scope: String(wire.scope ?? ''),
    tokenType: String(wire.token_type ?? ''),
    expiresIn: typeof wire.expires_in === 'number' ? wire.expires_in : 0,
  };
}
