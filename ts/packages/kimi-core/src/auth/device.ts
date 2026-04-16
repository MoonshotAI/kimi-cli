/**
 * Device identification headers for OAuth requests.
 *
 * Mirrors Python kimi_cli/auth/oauth.py:_common_headers() — same header
 * names so auth.kimi.com can correlate device activity between Python and
 * TS clients for the same user.
 *
 * Device ID is a persisted UUID under the kimi home dir, generated once
 * and reused forever. Lost/absent files get a fresh UUID.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, release, type, arch } from 'node:os';
import { join } from 'node:path';

import type { DeviceHeaders } from './types.js';

// Resolved lazily so KIMI_HOME at call time wins (test isolation).
let cachedDeviceId: string | undefined;
let cachedDeviceIdPath: string | undefined;

function homeDir(): string {
  const override = process.env['KIMI_HOME'];
  if (override && override.length > 0) return override;
  return join(process.env['HOME'] ?? '', '.kimi');
}

function deviceIdPath(): string {
  return join(homeDir(), 'device_id');
}

export function getDeviceId(): string {
  const current = deviceIdPath();
  if (cachedDeviceId !== undefined && cachedDeviceIdPath === current) {
    return cachedDeviceId;
  }

  if (existsSync(current)) {
    try {
      const text = readFileSync(current, 'utf-8').trim();
      if (text.length > 0) {
        cachedDeviceId = text;
        cachedDeviceIdPath = current;
        return text;
      }
    } catch {
      // fall through to regenerate
    }
  }

  const id = randomUUID();
  try {
    mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
    writeFileSync(current, id, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // best-effort — proceed with in-memory id even if write fails
  }
  cachedDeviceId = id;
  cachedDeviceIdPath = current;
  return id;
}

function deviceModel(): string {
  const os = type();
  const ver = release();
  const a = arch();
  if (os === 'Darwin') return `macOS ${ver} ${a}`;
  if (os === 'Windows_NT') return `Windows ${ver} ${a}`;
  return `${os} ${ver} ${a}`.trim();
}

function asciiHeader(value: string, fallback = 'unknown'): string {
  const cleaned = value.replace(/[^\x20-\x7E]/g, '').trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

let cliVersion = '0.1.0';

/** Allow kimi-cli bootstrap to inject its package.json version. */
export function setCliVersion(version: string): void {
  cliVersion = version;
}

export function getDeviceHeaders(): DeviceHeaders {
  return {
    'X-Msh-Platform': 'kimi_cli',
    'X-Msh-Version': asciiHeader(cliVersion),
    'X-Msh-Device-Name': asciiHeader(hostname()),
    'X-Msh-Device-Model': asciiHeader(deviceModel()),
    'X-Msh-Os-Version': asciiHeader(release()),
    'X-Msh-Device-Id': getDeviceId(),
  };
}

/** Test-only: clear the cached device id so tests can use tmp KIMI_HOME. */
export function _resetDeviceIdCacheForTest(): void {
  cachedDeviceId = undefined;
  cachedDeviceIdPath = undefined;
}
