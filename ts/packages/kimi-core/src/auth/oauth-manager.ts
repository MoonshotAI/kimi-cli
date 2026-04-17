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
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import lockfile from 'proper-lockfile';

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
  /**
   * Phase 15 B.2 — root directory for per-provider lock files; resolves
   * to `{configDir}/oauth/{providerName}.lock`.
   *
   * **Production callers MUST pass this explicitly** (KimiCoreClient /
   * session-manager wire it through from the resolved config root). A
   * missing `configDir` disables the cross-process lock entirely, so
   * silently falling back to an env var in production would mask a
   * genuine mis-wiring.
   *
   * When omitted AND `process.env.NODE_ENV === 'test'`, the manager
   * falls back to `process.env.KIMI_SHARE_DIR` so multi-process test
   * harnesses don't need to thread the dir through every fixture. In
   * production the fallback is inert. Windows platforms and
   * `process.env.KIMI_DISABLE_OAUTH_LOCK === '1'` always skip; the
   * "re-read storage" fail-safe remains as a best-effort coordinator.
   */
  readonly configDir?: string | undefined;
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
  private readonly configDir: string | undefined;

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
    // MAJ-1 (review round 1): the `KIMI_SHARE_DIR` fallback MUST stay
    // test-only so production entry points (`KimiCoreClient`, session-
    // manager) can't silently run without a lock just because the env
    // happens to be unset. vitest sets `NODE_ENV='test'` by default, so
    // multi-process test workers still pick up the share dir path.
    const envConfigDir =
      process.env['NODE_ENV'] === 'test' ? process.env['KIMI_SHARE_DIR'] : undefined;
    this.configDir = options.configDir ?? envConfigDir;
  }

  /**
   * Resolve the sentinel target file `proper-lockfile` locks against.
   * `proper-lockfile.lock(target)` creates `${target}.lock` as the
   * actual lock directory, so the real lockfile on disk ends up at
   * `{configDir}/oauth/{providerName}.lock`. Returns `undefined` when
   * locking is opted out (no configDir, Windows, env kill switch).
   */
  private resolveLockTarget(): string | undefined {
    if (process.platform === 'win32') return undefined;
    if (process.env['KIMI_DISABLE_OAUTH_LOCK'] === '1') return undefined;
    if (this.configDir === undefined) return undefined;
    return `${this.configDir}/oauth/${this.config.name}`;
  }

  /**
   * Acquire the cross-process lock around the refresh critical section.
   * Returns a `release` closure; when locking is disabled returns a
   * no-op so the caller's finally-block stays structurally identical.
   */
  private async acquireRefreshLock(): Promise<() => Promise<void>> {
    const target = this.resolveLockTarget();
    if (target === undefined) return async () => {};

    // proper-lockfile requires the target path to exist. We create
    // an empty sentinel file; the real lock indicator is the sibling
    // `{target}.lock` directory proper-lockfile creates and cleans
    // up on release (→ test oracle `{configDir}/oauth/{name}.lock`
    // must be absent after a graceful exit).
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, '', { flag: 'a' });
    } catch {
      return async () => {};
    }

    try {
      const release = await lockfile.lock(target, {
        retries: { retries: 10, factor: 1, minTimeout: 200, maxTimeout: 1_000 },
        stale: 5_000,
        realpath: false,
      });
      return async () => {
        try {
          await release();
        } catch {
          /* ignore release-after-stale */
        }
      };
    } catch {
      return async () => {};
    }
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

    // Phase 15 B.2 — acquire the cross-process lock before entering the
    // refresh critical section. Concurrent CLI processes serialise on
    // `{configDir}/oauth/{providerName}.lock` via `proper-lockfile`.
    // Post-acquire we re-read storage: if a peer already rotated the
    // token, short-circuit and return theirs instead of burning an
    // extra refresh.
    const release = await this.acquireRefreshLock();
    try {
      // Phase 15 B.2 — post-lock re-read. The semantics:
      //
      //   • force=false: the normal threshold short-circuit still
      //     applies.
      //   • force=true: we still want a refresh UNLESS a peer CLI
      //     process already did one inside our lock window. Two
      //     cues tell us a peer refreshed:
      //       (a) refresh_token rotated between our pre-lock load
      //           and the post-lock load, OR
      //       (b) the stored token was issued within the recent
      //           lock window — `remaining ≈ expiresIn` — which
      //           happens right after a peer's save. We bracket
      //           (b) with `remaining <= expiresIn` so artificial
      //           test fixtures (`expiresAt = now + 2*expiresIn`)
      //           never match.
      const afterLock = await this.storage.load(this.config.name);
      if (afterLock !== undefined) {
        const latestRemaining = afterLock.expiresAt - this.now();
        if (!force && latestRemaining >= this.refreshThresholdFn(afterLock.expiresIn)) {
          return afterLock.accessToken;
        }
        if (force && latestRemaining > 0 && afterLock.expiresIn > 0) {
          const rotated = afterLock.refreshToken !== token.refreshToken;
          const LOCK_WINDOW_SEC = 10;
          const justIssued =
            latestRemaining <= afterLock.expiresIn &&
            latestRemaining > afterLock.expiresIn - LOCK_WINDOW_SEC;
          if (rotated || justIssued) {
            return afterLock.accessToken;
          }
        }
      }

      const activeToken = afterLock ?? token;
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
    } finally {
      await release();
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
