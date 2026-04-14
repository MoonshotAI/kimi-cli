/**
 * Data directory and path helpers for kimi-cli.
 *
 * Mirrors the Python `share.py` / `metadata.py` path logic:
 * - Base data directory:  `KIMI_SHARE_DIR` env var  or  `~/.kimi-next`
 * - Sessions are stored under `<dataDir>/sessions/<md5(workDir)>/`
 * - Config file:           `<dataDir>/config.toml`
 * - MCP config:            `<dataDir>/mcp.json`
 * - Logs:                  `<dataDir>/logs/`
 *
 * Note: The TS version uses `~/.kimi-next` (not `~/.kimi`) to avoid conflicts
 * with the Python installation during the migration period.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Core data directory
// ---------------------------------------------------------------------------

/**
 * Return the root data directory for kimi-cli.
 *
 * Priority: `KIMI_SHARE_DIR` env var > `~/.kimi-next`
 */
export function getDataDir(): string {
  const envDir = process.env['KIMI_SHARE_DIR'];
  if (envDir) {
    return envDir;
  }
  return join(homedir(), '.kimi-next');
}

// ---------------------------------------------------------------------------
// Derived paths
// ---------------------------------------------------------------------------

/**
 * Return the sessions directory for a given working directory.
 *
 * The directory name is the MD5 hex digest of `workDir`, which mirrors the
 * Python implementation in `metadata.py`.
 */
export function getSessionsDir(workDir: string): string {
  const hash = createHash('md5').update(workDir, 'utf-8').digest('hex');
  return join(getDataDir(), 'sessions', hash);
}

/**
 * Return the default config file path: `<dataDir>/config.toml`.
 */
export function getConfigPath(): string {
  return join(getDataDir(), 'config.toml');
}

/**
 * Return the default MCP config file path: `<dataDir>/mcp.json`.
 */
export function getMCPConfigPath(): string {
  return join(getDataDir(), 'mcp.json');
}

/**
 * Return the log directory: `<dataDir>/logs/`.
 */
export function getLogDir(): string {
  return join(getDataDir(), 'logs');
}
