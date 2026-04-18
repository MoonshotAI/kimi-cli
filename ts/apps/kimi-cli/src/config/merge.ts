/**
 * Deep-merge two `KimiConfig`s — Phase 21 Slice C.2.1.
 *
 * Used to layer CLI-flag overrides (`--config` / `--config-file`) on top
 * of the disk-loaded base. Source (override) wins on every key:
 *   - scalars / arrays in `override` replace the base value
 *   - nested objects recurse (e.g. `providers['kimi']` partial patches
 *     existing entries instead of clobbering siblings)
 *   - `undefined` values in `override` are skipped so a stub override
 *     does not erase base keys
 */

import type { KimiConfig } from '@moonshot-ai/core';

export function mergeConfig(base: KimiConfig, override: KimiConfig): KimiConfig {
  const merged = deepMerge(
    base as unknown as Record<string, unknown>,
    override as unknown as Record<string, unknown>,
  );
  return merged as unknown as KimiConfig;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    if (sv === undefined) continue;
    const tv = out[key];
    out[key] = isPlainObject(tv) && isPlainObject(sv) ? deepMerge(tv, sv) : sv;
  }
  return out;
}
