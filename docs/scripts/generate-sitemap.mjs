#!/usr/bin/env node
/**
 * Generate sitemap.xml for SEO
 *
 * Scans all markdown files in docs/zh/ and docs/en/ directories
 * and generates a sitemap.xml file in docs/public/
 *
 * Run from the docs directory: node scripts/generate-sitemap.mjs
 */

import { readdirSync, statSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsDir = join(__dirname, "..");

const SITE_URL = "https://kimi-cli.com";
const OUTPUT_PATH = join(docsDir, "public/sitemap.xml");

/**
 * Recursively find all markdown files in a directory
 */
function findMarkdownFiles(dir, files = []) {
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      findMarkdownFiles(fullPath, files);
    } else if (entry.endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Convert file path to URL path
 */
function filePathToUrl(filePath) {
  let urlPath = relative(docsDir, filePath);

  // Remove .md extension
  urlPath = urlPath.replace(/\.md$/, "");

  // Convert index to directory path
  if (urlPath.endsWith("/index")) {
    urlPath = urlPath.slice(0, -6) + "/";
  } else if (urlPath === "index") {
    urlPath = "";
  } else {
    urlPath = urlPath + ".html";
  }

  return `${SITE_URL}/${urlPath}`;
}

/**
 * Generate sitemap XML content
 */
function generateSitemap(urls) {
  const today = new Date().toISOString().split("T")[0];

  const urlEntries = urls
    .map(
      (url) => `  <url>
    <loc>${url}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries}
</urlset>
`;
}

// Main
const zhFiles = findMarkdownFiles(join(docsDir, "zh"));
const enFiles = findMarkdownFiles(join(docsDir, "en"));
const rootIndex = join(docsDir, "index.md");

const allFiles = [...zhFiles, ...enFiles];

// Add root index if exists
try {
  statSync(rootIndex);
  allFiles.unshift(rootIndex);
} catch {
  // Root index doesn't exist, skip
}

const urls = allFiles.map(filePathToUrl);
const sitemap = generateSitemap(urls);

writeFileSync(OUTPUT_PATH, sitemap);
console.log(`Generated sitemap with ${urls.length} URLs: ${OUTPUT_PATH}`);
