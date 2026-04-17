/**
 * Platform gating helpers — Phase 14 §5.3.
 *
 * vitest has no direct equivalent of Python's `pytestmark = skipif(...)`.
 * These constants plus the re-exported `it.skipIf(...)` pattern let a test
 * file gate whole `describe` or individual `it` blocks on the host OS.
 *
 * Usage:
 *   import { isWindows } from '../helpers/platform.js';
 *   it.skipIf(!isWindows)('Windows-only behaviour', () => { ... });
 *
 * See phase-14-platform-extension.md §5.3 for the policy.
 */

export const isWindows: boolean = process.platform === 'win32';
export const isMacOS: boolean = process.platform === 'darwin';
export const isLinux: boolean = process.platform === 'linux';
export const isPosix: boolean = !isWindows;
