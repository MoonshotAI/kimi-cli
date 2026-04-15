/**
 * Sensitive-file detection — ports Python `kimi_cli/utils/sensitive.py`.
 *
 * The pattern list is intentionally small to avoid false positives; files
 * matching any of these patterns are blocked from Read/Write/Edit so
 * credentials cannot be exfiltrated through a compromised prompt. Exemptions
 * like `.env.example` are explicitly allowed.
 */

import { basename } from 'node:path';

const SENSITIVE_BASENAMES = new Set<string>([
  '.env',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'credentials',
]);

const SENSITIVE_PATH_SUFFIXES = ['.aws/credentials', '.gcp/credentials'];

const ENV_PREFIX = '.env.';
const ENV_EXEMPTIONS = new Set<string>(['.env.example', '.env.sample', '.env.template']);

export function isSensitiveFile(path: string): boolean {
  const name = basename(path);

  if (ENV_EXEMPTIONS.has(name)) return false;
  if (SENSITIVE_BASENAMES.has(name)) return true;
  if (name.startsWith(ENV_PREFIX)) return true;

  for (const suffix of SENSITIVE_PATH_SUFFIXES) {
    if (path.endsWith(`/${suffix}`) || path.includes(`/${suffix}/`)) {
      return true;
    }
  }

  return false;
}
