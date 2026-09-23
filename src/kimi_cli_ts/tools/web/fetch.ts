/**
 * FetchURL tool — fetch a web page and extract main text content.
 * Corresponds to Python tools/web/fetch.py
 */

import { z } from "zod/v4";
import { CallableTool } from "../base.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { ToolResultBuilder } from "../types.ts";

const DESCRIPTION =
	"Fetch a web page from a URL and extract main text content from it.";

const ParamsSchema = z.object({
	url: z.string().describe("The URL to fetch content from."),
});

type Params = z.infer<typeof ParamsSchema>;

export class FetchURL extends CallableTool<typeof ParamsSchema> {
	readonly name = "FetchURL";
	readonly description = DESCRIPTION;
	readonly schema = ParamsSchema;

	async execute(params: Params, ctx: ToolContext): Promise<ToolResult> {
		const builder = new ToolResultBuilder(50_000, null);

		try {
			// Try service-based fetch first (if configured)
			const fetchConfig = ctx.serviceConfig?.moonshotFetch;
			if (fetchConfig?.baseUrl) {
				// Resolve API key: prefer OAuth token, fall back to static api_key
				let apiKey = fetchConfig.apiKey;
				if (fetchConfig.oauth && ctx.runtime) {
					apiKey = await ctx.runtime.oauth.resolveApiKey(
						fetchConfig.apiKey,
						fetchConfig.oauth,
					);
				}
				if (apiKey) {
					try {
						const serviceResult = await fetchViaService(params.url, {
							baseUrl: fetchConfig.baseUrl,
							apiKey,
							customHeaders: fetchConfig.customHeaders,
						});
						if (serviceResult) {
							builder.write(serviceResult);
							return builder.ok("Content fetched via service.");
						}
					} catch {
						// Fall through to direct fetch
					}
				}
			}

			// Direct HTTP fetch
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 60_000);

			const response = await fetch(params.url, {
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
					Accept:
						"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				},
				signal: controller.signal,
				redirect: "follow",
			});

			clearTimeout(timeout);

			if (response.status >= 400) {
				return builder.error(
					`Failed to fetch URL. Status: ${response.status}. This may indicate the page is not accessible or the server is down.`,
				);
			}

			const respText = await response.text();
			const contentType = response.headers.get("content-type") || "";

			if (
				contentType.startsWith("text/plain") ||
				contentType.startsWith("text/markdown") ||
				contentType.startsWith("application/json")
			) {
				builder.write(respText);
				return builder.ok(
					"The returned content is the full content of the page.",
				);
			}

			if (!respText) {
				return builder.ok("The response body is empty.");
			}

			// Extract main content from HTML
			const extracted = extractContent(respText);

			if (!extracted || extracted.length < 10) {
				return builder.error(
					"Failed to extract meaningful content from the page. " +
						"The page may require JavaScript to render its content.",
				);
			}

			builder.write(extracted);
			return builder.ok(
				"The returned content is the main text content extracted from the page.",
			);
		} catch (e) {
			if (e instanceof DOMException && e.name === "AbortError") {
				return builder.error(
					"Failed to fetch URL: request timed out. The server may be slow or unreachable.",
				);
			}
			return builder.error(
				`Failed to fetch URL due to network error: ${e}. The URL may be invalid or the server is unreachable.`,
			);
		}
	}
}

/** Try fetching via moonshot fetch service. */
async function fetchViaService(
	url: string,
	config: {
		baseUrl: string;
		apiKey: string;
		customHeaders?: Record<string, string>;
	},
): Promise<string | null> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 90_000);

	const response = await fetch(config.baseUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.apiKey}`,
			...(config.customHeaders ?? {}),
		},
		body: JSON.stringify({ url }),
		signal: controller.signal,
	});

	clearTimeout(timeout);

	if (!response.ok) return null;

	const data = (await response.json()) as { content?: string; text?: string };
	return data.content || data.text || null;
}

// ── HTML Content Extraction ──────────────────────────
// A proper content extraction that handles structure, entities, and main content detection.

/** Decode all HTML entities (named + numeric). */
function decodeEntities(text: string): string {
	const namedEntities: Record<string, string> = {
		nbsp: " ",
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		ldquo: "\u201C",
		rdquo: "\u201D",
		lsquo: "\u2018",
		rsquo: "\u2019",
		mdash: "\u2014",
		ndash: "\u2013",
		hellip: "\u2026",
		copy: "\u00A9",
		reg: "\u00AE",
		trade: "\u2122",
		bull: "\u2022",
		middot: "\u00B7",
		laquo: "\u00AB",
		raquo: "\u00BB",
	};

	return text
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, n) =>
			String.fromCodePoint(parseInt(n, 16)),
		)
		.replace(
			/&(\w+);/g,
			(match, name) => namedEntities[name.toLowerCase()] ?? match,
		);
}

/** Extract readable text content from HTML. */
function extractContent(html: string): string {
	// Step 1: Remove non-content elements entirely
	let text = html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
		.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, "")
		.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "") // Navigation
		.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "") // Footer
		.replace(/<!--[\s\S]*?-->/g, ""); // HTML comments

	// Step 2: Extract title
	const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = titleMatch ? decodeEntities(titleMatch[1]!.trim()) : "";

	// Step 3: Try to find main content area
	let mainContent = "";
	const mainPatterns = [
		/<main[^>]*>([\s\S]*?)<\/main>/i,
		/<article[^>]*>([\s\S]*?)<\/article>/i,
		/<div[^>]*(?:class|id)="[^"]*(?:content|article|post|entry|main)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
	];

	for (const pattern of mainPatterns) {
		const match = text.match(pattern);
		if (match && match[1]!.length > 200) {
			mainContent = match[1]!;
			break;
		}
	}

	// Fall back to body or full text
	if (!mainContent) {
		const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
		mainContent = bodyMatch ? bodyMatch[1]! : text;
	}

	// Step 4: Convert headings to markdown-style
	mainContent = mainContent
		.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n# $1\n\n")
		.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n")
		.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n\n### $1\n\n")
		.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, "\n\n#### $1\n\n");

	// Step 5: Handle links — extract text with URL
	mainContent = mainContent.replace(
		/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
		(_, href, text) => {
			const linkText = text.replace(/<[^>]+>/g, "").trim();
			if (!linkText) return "";
			// Only show URL for external links
			if (href.startsWith("http")) return `[${linkText}](${href})`;
			return linkText;
		},
	);

	// Step 6: Handle lists
	mainContent = mainContent
		.replace(/<li[^>]*>/gi, "\n- ")
		.replace(/<\/li>/gi, "");

	// Step 7: Handle tables — convert to simple text
	mainContent = mainContent
		.replace(/<tr[^>]*>/gi, "\n")
		.replace(/<\/tr>/gi, "")
		.replace(/<t[hd][^>]*>/gi, "\t")
		.replace(/<\/t[hd]>/gi, "");

	// Step 8: Handle block elements
	mainContent = mainContent
		.replace(/<\/?(p|div|section|header|blockquote)[^>]*>/gi, "\n\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<hr\s*\/?>/gi, "\n---\n")
		.replace(/<\/?(pre|code)[^>]*>/gi, "\n```\n");

	// Step 9: Remove all remaining HTML tags
	mainContent = mainContent.replace(/<[^>]+>/g, "");

	// Step 10: Decode entities
	mainContent = decodeEntities(mainContent);

	// Step 11: Clean up whitespace
	mainContent = mainContent
		.replace(/[ \t]+/g, " ") // Collapse horizontal whitespace
		.replace(/\n[ \t]+/g, "\n") // Remove leading whitespace on lines
		.replace(/[ \t]+\n/g, "\n") // Remove trailing whitespace on lines
		.replace(/\n{3,}/g, "\n\n") // Max 2 consecutive newlines
		.trim();

	// Prepend title if found
	if (title && !mainContent.startsWith(title)) {
		mainContent = `# ${title}\n\n${mainContent}`;
	}

	return mainContent;
}
