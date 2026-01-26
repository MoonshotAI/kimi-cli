#!/usr/bin/env node
/**
 * Sync CHANGELOG.md to docs/en/release-notes/changelog.md
 *
 * This script copies the content from the root CHANGELOG.md to the docs site,
 * with only formatting changes (title format).
 *
 * Run from the docs directory: node scripts/sync-changelog.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsDir = join(__dirname, "..");
const rootDir = join(docsDir, "..");

const sourcePath = join(rootDir, "CHANGELOG.md");
const targetPath = join(docsDir, "en/release-notes/changelog.md");

const HEADER = `# Changelog

This page documents the changes in each Kimi Code CLI release.

`;

// Read the source file
let content = readFileSync(sourcePath, "utf-8");

// Remove the HTML comment block at the top
content = content.replace(/<!--[\s\S]*?-->\n*/g, "");

// Remove the "# Changelog" title (we'll add our own header)
content = content.replace(/^# Changelog\n+/, "");

// Convert title format: ## [0.69] - 2025-12-29 -> ## 0.69 (2025-12-29)
content = content.replace(
  /^## \[([^\]]+)\] - (\d{4}-\d{1,2}-\d{1,2})/gm,
  "## $1 ($2)"
);

// Remove subsection headers like ### Added, ### Changed, ### Fixed
content = content.replace(/^### (Added|Changed|Fixed|Improved|Tools|SDK)\n+/gm, "");

// Write the target file
writeFileSync(targetPath, HEADER + content.trim() + "\n");

console.log(`Synced changelog to ${targetPath}`);
