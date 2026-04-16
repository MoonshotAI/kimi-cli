/**
 * Auth module public API — OAuth token management for managed providers.
 *
 * Typical wiring from the host (kimi-cli):
 *   const storage = new FileTokenStorage('~/.kimi/credentials');
 *   const manager = new OAuthManager({
 *     config: KIMI_CODE_FLOW_CONFIG,
 *     storage,
 *   });
 *   // In provider factory deps:
 *   oauthResolver: async (name) => {
 *     if (name === 'managed:kimi-code') return manager.ensureFresh();
 *     throw new Error(`No OAuth manager for ${name}`);
 *   }
 */

export {
  DeviceCodeExpiredError,
  DeviceCodeTimeoutError,
  OAuthError,
  OAuthUnauthorizedError,
  RetryableRefreshError,
} from './errors.js';

export type {
  DeviceAuthorization,
  DeviceHeaders,
  OAuthFlowConfig,
  OAuthStorageBackend,
  TokenInfo,
  TokenInfoWire,
} from './types.js';
export { tokenFromWire, tokenToWire } from './types.js';

export type { TokenStorage } from './storage.js';
export { FileTokenStorage } from './storage.js';

export type { DevicePollResult, RefreshOptions } from './oauth.js';
export {
  pollDeviceToken,
  refreshAccessToken,
  requestDeviceAuthorization,
} from './oauth.js';

export type { LoginOptions, OAuthManagerOptions } from './oauth-manager.js';
export { OAuthManager, defaultRefreshThreshold, newInstanceId } from './oauth-manager.js';

export { getDeviceHeaders, getDeviceId, setCliVersion } from './device.js';

/** Well-known flow config for managed:kimi-code (matches Python constants). */
import type { OAuthFlowConfig } from './types.js';
export const KIMI_CODE_FLOW_CONFIG: OAuthFlowConfig = {
  name: 'kimi-code',
  oauthHost:
    process.env['KIMI_CODE_OAUTH_HOST'] ??
    process.env['KIMI_OAUTH_HOST'] ??
    'https://auth.kimi.com',
  clientId: '17e5f671-d194-4dfb-9706-5516cb48c098',
};
