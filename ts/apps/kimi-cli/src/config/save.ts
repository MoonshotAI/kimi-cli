/**
 * Config persistence helpers — write user-facing preferences back to
 * `config.toml` without clobbering unrelated keys.
 *
 * Used by slash commands like `/editor <cmd>` that persist a UI
 * preference. For writing the full `Config` object (e.g. initial
 * scaffolding), see `loader.ts` instead.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse as parseTOML, stringify as stringifyTOML } from 'smol-toml';

import { getConfigPath } from './paths.js';

export function saveConfigPatch(patch: Record<string, unknown>): void {
  const path = getConfigPath();
  let data: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed: unknown = parseTOML(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed existing file — fall back to a fresh object rather
      // than aborting the save. The next successful parse will expose
      // the problem through the normal config-load path.
    }
  }
  Object.assign(data, patch);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyTOML(data), 'utf-8');
}
