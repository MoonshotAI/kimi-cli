/**
 * rg-locator — hybrid ripgrep binary resolution.
 *
 * Lookup order (first hit wins):
 *   1. System PATH (`which rg`) — fastest, respects developer setup
 *   2. Bundled vendor binary (future hook; currently a no-op)
 *   3. `<KIMI_SHARE_DIR>/bin/rg` — persistent cache, shared with Python
 *      kimi-cli so moving between CLIs doesn't re-download.
 *   4. CDN download to <KIMI_SHARE_DIR>/bin/ — one-off bootstrap
 *
 * If steps 1-4 all fail, callers receive a structured error they can
 * turn into a user-facing "install ripgrep" hint instead of the naked
 * `spawn rg ENOENT`.
 */

import { createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { extract as extractTar } from 'tar';

const RG_VERSION = '15.0.0';
const RG_BASE_URL = 'http://cdn.kimi.com/binaries/kimi-cli/rg';
const DOWNLOAD_TIMEOUT_MS = 600_000;

export type RgResolutionSource =
  | 'system-path'
  | 'vendor'
  | 'share-bin-cached'
  | 'share-bin-downloaded';

export interface RgResolution {
  readonly path: string;
  readonly source: RgResolutionSource;
}

/**
 * Resolve the absolute path to a usable `rg` binary, downloading it
 * into `<shareDir>/bin/` if necessary. Multiple concurrent callers are
 * serialized by a module-level lock so the download happens at most
 * once per process.
 */
export async function ensureRgPath(
  options: { shareDir?: string } = {},
): Promise<RgResolution> {
  const shareDir = options.shareDir ?? getShareDir();
  const existing = await findExistingRg(shareDir);
  if (existing) return existing;
  return downloadRgWithLock(shareDir);
}

/**
 * Pure-lookup variant for test harnesses that want to assert on the
 * resolution order without triggering a real download.
 */
export async function findExistingRg(
  shareDir: string,
): Promise<RgResolution | undefined> {
  const binName = rgBinaryName();
  const systemRg = await whichRg();
  if (systemRg !== undefined) return { path: systemRg, source: 'system-path' };
  const vendorPath = getVendorRgPath(binName);
  if (vendorPath !== undefined && (await isExecutableFile(vendorPath))) {
    return { path: vendorPath, source: 'vendor' };
  }
  const cachePath = join(shareDir, 'bin', binName);
  if (await isExecutableFile(cachePath)) {
    return { path: cachePath, source: 'share-bin-cached' };
  }
  return undefined;
}

let downloadPromise: Promise<RgResolution> | undefined;
async function downloadRgWithLock(shareDir: string): Promise<RgResolution> {
  if (downloadPromise !== undefined) return downloadPromise;
  downloadPromise = (async () => {
    try {
      const existing = await findExistingRg(shareDir);
      if (existing) return existing;
      const binPath = await downloadAndInstallRg(shareDir);
      return { path: binPath, source: 'share-bin-downloaded' };
    } finally {
      downloadPromise = undefined;
    }
  })();
  return downloadPromise;
}

function rgBinaryName(): string {
  return process.platform === 'win32' ? 'rg.exe' : 'rg';
}

function getShareDir(): string {
  const override = process.env['KIMI_SHARE_DIR'];
  if (override !== undefined && override !== '') return override;
  return join(homedir(), '.kimi');
}

function getVendorRgPath(_binName: string): string | undefined {
  return undefined;
}

async function whichRg(): Promise<string | undefined> {
  const pathEnv = process.env['PATH'] ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const binName = rgBinaryName();
  for (const dir of pathEnv.split(sep)) {
    if (dir === '') continue;
    const candidate = join(dir, binName);
    try {
      const st = await stat(candidate);
      if (st.isFile()) return candidate;
    } catch {
      /* not here, try next */
    }
  }
  return undefined;
}

async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/** @internal for tests — rust-style `<arch>-<vendor>-<os>` target triple. */
export function detectTarget(): string | undefined {
  const arch = (() => {
    if (process.arch === 'x64') return 'x86_64';
    if (process.arch === 'arm64') return 'aarch64';
    return undefined;
  })();
  if (arch === undefined) return undefined;

  if (process.platform === 'darwin') return `${arch}-apple-darwin`;
  if (process.platform === 'linux') {
    return arch === 'x86_64'
      ? 'x86_64-unknown-linux-musl'
      : 'aarch64-unknown-linux-gnu';
  }
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`;
  return undefined;
}

async function downloadAndInstallRg(shareDir: string): Promise<string> {
  const target = detectTarget();
  if (target === undefined) {
    throw new Error(
      `Unsupported platform/arch for ripgrep download: ${process.platform}/${process.arch}`,
    );
  }

  if (target.includes('windows')) {
    throw new Error(
      'Automatic ripgrep download is not implemented for Windows yet. ' +
        'Install ripgrep from https://github.com/BurntSushi/ripgrep/releases ' +
        'and make sure `rg.exe` is on PATH.',
    );
  }

  const archiveName = `ripgrep-${RG_VERSION}-${target}.tar.gz`;
  const url = `${RG_BASE_URL}/${archiveName}`;

  const binDir = join(shareDir, 'bin');
  await mkdir(binDir, { recursive: true });
  const destination = join(binDir, rgBinaryName());

  const tmp = await mkdtemp(join(tmpdir(), 'kimi-rg-'));
  try {
    const archivePath = join(tmp, archiveName);

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, DOWNLOAD_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutHandle);
    }
    if (!resp.ok || resp.body === null) {
      throw new Error(
        `Failed to download ripgrep: HTTP ${String(resp.status)} ${resp.statusText}`,
      );
    }
    const write = createWriteStream(archivePath);
    // Readable.fromWeb is typed as accepting a web ReadableStream; the
    // undici/fetch body matches that shape at runtime.
    await pipeline(Readable.fromWeb(resp.body as never), write);

    const extractDir = join(tmp, 'extract');
    await mkdir(extractDir, { recursive: true });
    await extractTar({
      file: archivePath,
      cwd: extractDir,
      gzip: true,
      filter: (entryPath: string) => entryPath.endsWith(`/${rgBinaryName()}`),
    });
    const extracted = join(
      extractDir,
      `ripgrep-${RG_VERSION}-${target}`,
      rgBinaryName(),
    );
    if (!existsSync(extracted)) {
      throw new Error(
        `Ripgrep archive did not contain expected binary at ${extracted}. ` +
          'CDN content may have changed.',
      );
    }
    await rename(extracted, destination);
    await chmod(destination, 0o755);
    return destination;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * User-facing error message to show when `ensureRgPath` throws. Kept
 * in one place so the Grep / Glob / Bash plumbing can reuse it.
 */
export function rgUnavailableMessage(cause: unknown): string {
  const detail =
    cause instanceof Error
      ? cause.message
      : typeof cause === 'string'
        ? cause
        : 'unknown error';
  const shareBin = join(getShareDir(), 'bin', rgBinaryName());
  return (
    `ripgrep (rg) is not available and the automatic bootstrap failed.\n` +
    `\n` +
    `Error: ${detail}\n` +
    `\n` +
    `Fix options:\n` +
    `  macOS:   brew install ripgrep\n` +
    `  Ubuntu:  sudo apt-get install ripgrep\n` +
    `  Other:   https://github.com/BurntSushi/ripgrep#installation\n` +
    `\n` +
    `Alternatively, drop a static rg binary at ${shareBin}`
  );
}
