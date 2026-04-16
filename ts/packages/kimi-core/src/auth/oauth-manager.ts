/**
 * OAuthManager — per-provider token lifecycle (load / refresh / login / logout).
 *
 * Slice 5.0 MVP:
 *  - Lazy refresh on `ensureFresh()` (no background loop, D decision)
 *  - Single-process concurrency: in-memory mutex serialises refreshes
 *  - Multi-process coordination: before + after storage re-read, so a
 *    concurrent refresh from another CLI process is detected (best-effort)
 *  - `login()`: device code flow with 15 min local timeout (D2)
 *  - `logout()`: delete stored token
 *
 * All network / clock / storage operations are injectable for tests.
 */

import { randomUUID } from 'node:crypto';

import {
  DeviceCodeTimeoutError,
  OAuthError,
  OAuthUnauthorizedError,
} from './errors.js';
import {
  pollDeviceToken,
  refreshAccessToken,
  requestDeviceAuthorization,
} from './oauth.js';
import type { DevicePollResult, RefreshOptions } from './oauth.js';
import type { TokenStorage } from './storage.js';
import type {
  DeviceAuthorization,
  OAuthFlowConfig,
  TokenInfo,
} from './types.js';

const MIN_REFRESH_THRESHOLD_SECONDS = 300;
const REFRESH_THRESHOLD_RATIO = 0.5;
const DEFAULT_DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000;

export function defaultRefreshThreshold(expiresIn: number): number {
  if (expiresIn > 0) {
    return Math.max(MIN_REFRESH_THRESHOLD_SECONDS, expiresIn * REFRESH_THRESHOLD_RATIO);
  }
  return MIN_REFRESH_THRESHOLD_SECONDS;
}

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export interface OAuthManagerOptions {
  readonly config: OAuthFlowConfig;
  readonly storage: TokenStorage;
  readonly refreshThreshold?: ((expiresIn: number) => number) | undefined;
  readonly deviceCodeTimeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly sleep?: Sleep | undefined;
  readonly refreshTokenImpl?:
    | ((
        config: OAuthFlowConfig,
        refreshToken: string,
        options?: RefreshOptions,
      ) => Promise<TokenInfo>)
    | undefined;
  readonly requestDeviceImpl?: ((config: OAuthFlowConfig) => Promise<DeviceAuthorization>) | undefined;
  readonly pollDeviceImpl?:
    | ((config: OAuthFlowConfig, deviceCode: string) => Promise<DevicePollResult>)
    | undefined;
}

export interface LoginOptions {
  readonly onDeviceCode?: ((auth: DeviceAuthorization) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export class OAuthManager {
  private readonly config: OAuthFlowConfig;
  private readonly storage: TokenStorage;
  private readonly refreshThresholdFn: (expiresIn: number) => number;
  private readonly deviceCodeTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: Sleep;
  private readonly refreshImpl: NonNullable<OAuthManagerOptions['refreshTokenImpl']>;
  private readonly requestImpl: NonNullable<OAuthManagerOptions['requestDeviceImpl']>;
  private readonly pollImpl: NonNullable<OAuthManagerOptions['pollDeviceImpl']>;

  /** In-flight refresh coalescer: one refresh per ensureFresh race. */
  private inFlightRefresh: Promise<string> | undefined;

  constructor(options: OAuthManagerOptions) {
    this.config = options.config;
    this.storage = options.storage;
    this.refreshThresholdFn = options.refreshThreshold ?? defaultRefreshThreshold;
    this.deviceCodeTimeoutMs = options.deviceCodeTimeoutMs ?? DEFAULT_DEVICE_CODE_TIMEOUT_MS;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.sleep = options.sleep ?? defaultSleep;
    this.refreshImpl = options.refreshTokenImpl ?? refreshAccessToken;
    this.requestImpl = options.requestDeviceImpl ?? requestDeviceAuthorization;
    this.pollImpl = options.pollDeviceImpl ?? pollDeviceToken;
  }

  async hasToken(): Promise<boolean> {
    const token = await this.storage.load(this.config.name);
    return token !== undefined && token.accessToken.length > 0;
  }

  async logout(): Promise<void> {
    await this.storage.remove(this.config.name);
  }

  /**
   * Return a valid access_token, refreshing if within the dynamic threshold.
   * Throws if no token is persisted (caller should invoke `/login`).
   */
  async ensureFresh(options: { force?: boolean } = {}): Promise<string> {
    // Coalesce concurrent callers onto one refresh in flight.
    if (this.inFlightRefresh !== undefined) {
      return this.inFlightRefresh;
    }
    this.inFlightRefresh = this.doEnsureFresh(options.force === true).finally(() => {
      this.inFlightRefresh = undefined;
    });
    return this.inFlightRefresh;
  }

  private async doEnsureFresh(force: boolean): Promise<string> {
    const token = await this.storage.load(this.config.name);
    if (token === undefined || token.accessToken.length === 0) {
      throw new OAuthError(
        `No token for "${this.config.name}". Run /login to authenticate.`,
      );
    }

    const remaining = token.expiresAt - this.now();
    const threshold = this.refreshThresholdFn(token.expiresIn);
    const needRefresh = force || remaining < threshold;
    if (!needRefresh) {
      return token.accessToken;
    }

    // Multi-process coordination: re-read storage right before refresh in
    // case another CLI instance rotated tokens while we waited elsewhere.
    //
    // FIXME(slice-5.x): this only catches refresh_token rotation. If the
    // OAuth server re-issues the SAME refresh_token on every refresh
    // (no rotation) two concurrent processes will both refresh the
    // access_token — wasting one request but not breaking correctness.
    // A real cross-process lock (proper-lockfile or fcntl-style file
    // lock) is the correct fix; tracked in Phase 5 follow-ups.
    const latest = await this.storage.load(this.config.name);
    if (
      !force &&
      latest !== undefined &&
      latest.refreshToken !== token.refreshToken
    ) {
      const latestRemaining = latest.expiresAt - this.now();
      if (latestRemaining >= this.refreshThresholdFn(latest.expiresIn)) {
        return latest.accessToken;
      }
    }

    const activeToken = latest ?? token;
    if (activeToken.refreshToken.length === 0) {
      throw new OAuthError(
        `Token for "${this.config.name}" has no refresh_token; re-login required.`,
      );
    }

    try {
      const refreshed = await this.refreshImpl(this.config, activeToken.refreshToken);
      await this.storage.save(this.config.name, refreshed);
      return refreshed.accessToken;
    } catch (err) {
      if (err instanceof OAuthUnauthorizedError) {
        // 401/403 might mean (a) refresh_token genuinely revoked or
        // (b) another process rotated the refresh_token while we were
        // mid-flight. Check (b) first: re-read storage, and if the
        // current refresh_token differs from what we sent, treat the
        // 401 as a stale-token race and use the rotated value.
        // (Mirrors Python `_refresh_tokens` 943-950.)
        await this.sleep(100);
        const latestAfterFail = await this.storage.load(this.config.name);
        if (
          latestAfterFail !== undefined &&
          latestAfterFail.refreshToken !== activeToken.refreshToken &&
          latestAfterFail.accessToken.length > 0
        ) {
          return latestAfterFail.accessToken;
        }
        // Genuine revoke — delete so caller drives /login.
        await this.storage.remove(this.config.name);
      }
      throw err;
    }
  }

  /**
   * Drive the device code flow end-to-end. `onDeviceCode` is called once
   * the user code is available so the caller can display it.
   *
   * Local 15-min budget (D2) guards against forever-pending flows.
   */
  async login(options: LoginOptions = {}): Promise<TokenInfo> {
    const startedAt = this.now();
    const deadlineAt = startedAt + Math.ceil(this.deviceCodeTimeoutMs / 1000);

    while (true) {
      const auth = await this.requestImpl(this.config);
      options.onDeviceCode?.(auth);

      // RFC 8628 §3.5: clients must add at least 5s on `slow_down` and
      // continue polling at the increased interval thereafter.
      let currentInterval = Math.max(auth.interval, 1);
      // Poll until success, denial, local timeout, or expired_token (retry outer).
      let deviceExpired = false;
      while (true) {
        this.throwIfAborted(options.signal);
        if (this.now() >= deadlineAt) {
          throw new DeviceCodeTimeoutError(
            `Device authorization timed out after ${Math.ceil(
              this.deviceCodeTimeoutMs / 1000,
            )}s`,
          );
        }

        const result = await this.pollImpl(this.config, auth.deviceCode);
        if (result.kind === 'success') {
          await this.storage.save(this.config.name, result.token);
          return result.token;
        }
        if (result.kind === 'denied') {
          throw new OAuthError(
            `Authorization denied${result.description ? `: ${result.description}` : ''}`,
          );
        }
        if (result.kind === 'expired') {
          deviceExpired = true;
          break;
        }
        // pending: bump interval permanently when server requests slow_down.
        if (result.errorCode === 'slow_down') {
          currentInterval += 5;
        }
        await this.sleep(currentInterval * 1000);
      }
      if (!deviceExpired) break;
      // Otherwise loop outer to request a new device code.
      // Guard: if we're already past the deadline, bail.
      if (this.now() >= deadlineAt) {
        throw new DeviceCodeTimeoutError('Device authorization timed out');
      }
    }

    // Unreachable — inner loop always returns or throws.
    throw new OAuthError('Device flow ended unexpectedly');
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
      throw new OAuthError('Login aborted by caller');
    }
  }
}

/**
 * Generate a synthetic OAuth client instance id. Used by `/login` to
 * correlate device flows with the CLI instance without depending on
 * runtime state. Not required by the protocol — purely for diagnostics.
 */
export function newInstanceId(): string {
  return randomUUID();
}
