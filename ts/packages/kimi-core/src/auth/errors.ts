/**
 * OAuth error classes.
 *
 * All errors derive from {@link OAuthError}. Distinguishing subclasses let
 * callers react appropriately:
 *  - `OAuthUnauthorizedError`: 401/403 from token endpoint → refresh_token
 *    or credentials are bad; drive user through `/login` again.
 *  - `DeviceCodeExpiredError`: device_code TTL ran out before user approved;
 *    restart the device flow.
 *  - `DeviceCodeTimeoutError`: local 15 min wall-clock budget exhausted
 *    (D2 from Slice 5.0 brief).
 *  - `RetryableRefreshError`: 429 / 5xx from token endpoint; the refresh
 *    helper retries with exponential backoff before surfacing this.
 */

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthError';
  }
}

export class OAuthUnauthorizedError extends OAuthError {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthUnauthorizedError';
  }
}

export class DeviceCodeExpiredError extends OAuthError {
  constructor(message = 'Device code expired.') {
    super(message);
    this.name = 'DeviceCodeExpiredError';
  }
}

export class DeviceCodeTimeoutError extends OAuthError {
  constructor(message = 'Device authorization timed out locally.') {
    super(message);
    this.name = 'DeviceCodeTimeoutError';
  }
}

export class RetryableRefreshError extends OAuthError {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableRefreshError';
  }
}
