#!/usr/bin/env bun
/**
 * Fast dev launcher — pre-bundles src/kimi_cli_ts/ into a single JS file
 * and runs it. On subsequent runs, only re-bundles if source files changed.
 *
 * Usage:  bun run dev        (via package.json)
 *         bun scripts/dev.ts (direct)
 */

import { resolve, join } from "node:path";
import { Glob } from "bun";

const ROOT = resolve(import.meta.dirname, "..");
const SRC_DIR = join(ROOT, "src", "kimi_cli_ts");
const ENTRY = join(SRC_DIR, "index.ts");
const OUT_DIR = join(ROOT, "dist");
const OUT_FILE = join(OUT_DIR, "dev.js");
const HASH_FILE = join(OUT_DIR, ".dev-hash");

// ── Hash source files ──────────────────────────────────────

async function computeSourceHash(): Promise<string> {
  const hasher = new Bun.CryptoHasher("xxhash64");
  const glob = new Glob("**/*.{ts,tsx}");

  // Collect and sort for deterministic hashing
  const files: string[] = [];
  for await (const path of glob.scan({ cwd: SRC_DIR, absolute: true })) {
    files.push(path);
  }
  files.sort();

  for (const file of files) {
    const buf = await Bun.file(file).arrayBuffer();
    hasher.update(file); // include path so renames are detected
    hasher.update(new Uint8Array(buf));
  }

  // Also include package.json (dependency changes)
  const pkgBuf = await Bun.file(join(ROOT, "package.json")).arrayBuffer();
  hasher.update(new Uint8Array(pkgBuf));

  return hasher.digest("hex") as string;
}

async function readCachedHash(): Promise<string | null> {
  try {
    return await Bun.file(HASH_FILE).text();
  } catch {
    return null;
  }
}

// ── Build ──────────────────────────────────────────────────

async function build(): Promise<boolean> {
  const result = await Bun.build({
    entrypoints: [ENTRY],
    outdir: OUT_DIR,
    naming: "dev.js",
    target: "bun",
    sourcemap: "linked", // enables stack traces back to .ts sources
  });

  if (!result.success) {
    console.error("Build failed:");
    for (const msg of result.logs) {
      console.error(" ", msg);
    }
    return false;
  }
  return true;
}

// ── Main ───────────────────────────────────────────────────

const currentHash = await computeSourceHash();
const cachedHash = await readCachedHash();

if (currentHash !== cachedHash || !(await Bun.file(OUT_FILE).exists())) {
  const t0 = performance.now();
  const ok = await build();
  if (!ok) process.exit(1);
  await Bun.write(HASH_FILE, currentHash);
  console.error(`[dev] rebuilt in ${(performance.now() - t0).toFixed(0)}ms`);
} else {
  console.error("[dev] cache hit — skipping build");
}

// Forward all CLI args (strip "bun", "run", "dev" / script path)
const args = process.argv.slice(2);

// Exec the bundled file
const proc = Bun.spawn(["bun", OUT_FILE, ...args], {
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...process.env },
  cwd: ROOT,
});

// Forward exit code
const exitCode = await proc.exited;
process.exit(exitCode);
