import { AsyncLocalStorage } from 'node:async_hooks';

import type { Kaos } from './kaos.js';
import { LocalKaos } from './local.js';

const kaosStorage = new AsyncLocalStorage<Kaos>();

// Lazy-initialized default instance
let defaultKaos: Kaos | null = null;
function getDefaultKaos(): Kaos {
  if (defaultKaos === null) {
    defaultKaos = new LocalKaos();
  }
  return defaultKaos;
}

/**
 * Return the {@link Kaos} instance for the current async context.
 *
 * If {@link runWithKaos} has bound an instance for this context it is
 * returned; otherwise a lazily-created {@link LocalKaos} default is used.
 */
export function getCurrentKaos(): Kaos {
  return kaosStorage.getStore() ?? getDefaultKaos();
}

/**
 * Run a callback with a specific Kaos instance bound to the async context.
 * This is the recommended, concurrency-safe API.
 */
export function runWithKaos<T>(kaos: Kaos, fn: () => T): T {
  return kaosStorage.run(kaos, fn);
}

/**
 * Token returned by setCurrentKaos, used to restore the previous instance.
 * Mirrors Python's ContextVar Token pattern.
 */
export interface KaosToken {
  readonly previousKaos: Kaos | null;
}

/**
 * Set the current kaos instance and return a token for restoring the previous one.
 *
 * Unlike a plain module-level global, this binds the override to the current
 * async context so concurrent tasks do not pollute each other. The returned
 * token can later be passed to {@link resetCurrentKaos} to restore the
 * previously-visible instance, mirroring Python's ContextVar token pattern.
 */
export function setCurrentKaos(kaos: Kaos): KaosToken {
  const token: KaosToken = { previousKaos: getCurrentKaos() };
  kaosStorage.enterWith(kaos);
  return token;
}

/**
 * Restore the kaos instance from a previously obtained token.
 */
export function resetCurrentKaos(token: KaosToken): void {
  kaosStorage.enterWith(token.previousKaos ?? getDefaultKaos());
}
