/**
 * SearchWeb tool — web search via moonshot search service.
 * Corresponds to Python tools/web/search.py
 */

import { z } from "zod/v4";
import { CallableTool } from "../base.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { ToolError, ToolResultBuilder } from "../types.ts";

const DESCRIPTION =
	"WebSearch tool allows you to search on the internet to get latest information, including news, documents, release notes, blog posts, papers, etc.";

const ParamsSchema = z.object({
	query: z.string().describe("The query text to search for."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(20)
		.default(5)
		.describe("The number of results to return."),
	include_content: z
		.boolean()
		.default(false)
		.describe(
			"Whether to include the content of the web pages in the results. Can consume many tokens.",
		),
});

type Params = z.infer<typeof ParamsSchema>;

interface SearchResult {
	site_name: string;
	title: string;
	url: string;
	snippet: string;
	content?: string;
	date?: string;
}

export class SearchWeb extends CallableTool<typeof ParamsSchema> {
	readonly name = "SearchWeb";
	readonly description = DESCRIPTION;
	readonly schema = ParamsSchema;

	async execute(params: Params, ctx: ToolContext): Promise<ToolResult> {
		const builder = new ToolResultBuilder(50_000, null);

		const searchConfig = ctx.serviceConfig?.moonshotSearch;
		if (!searchConfig?.baseUrl) {
			return builder.error(
				"Search service is not configured. You may want to try other methods to search.",
			);
		}

		// Resolve API key: prefer OAuth token, fall back to static api_key
		let apiKey = searchConfig.apiKey;
		if (searchConfig.oauth && ctx.runtime) {
			const resolved = await ctx.runtime.oauth.resolveApiKey(
				searchConfig.apiKey,
				searchConfig.oauth,
			);
			apiKey = resolved;
		}
		if (!apiKey) {
			return builder.error(
				"Search service is not configured. You may want to try other methods to search.",
			);
		}

		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 180_000); // 3 min total timeout

			const response = await fetch(searchConfig.baseUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
					...(searchConfig.customHeaders ?? {}),
				},
				body: JSON.stringify({
					text_query: params.query,
					limit: params.limit,
					enable_page_crawling: params.include_content,
					timeout_seconds: 30,
				}),
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (!response.ok) {
				return builder.error(
					`Failed to search. Status: ${response.status}. ` +
						"This may indicate that the search service is currently unavailable.",
				);
			}

			const data = (await response.json()) as {
				search_results?: SearchResult[];
			};
			const results = data.search_results ?? [];

			if (results.length === 0) {
				return builder.ok("No search results found.");
			}

			for (let i = 0; i < results.length; i++) {
				const result = results[i]!;
				if (i > 0) builder.write("---\n\n");
				builder.write(
					`Title: ${result.title}\n` +
						`Date: ${result.date ?? ""}\n` +
						`URL: ${result.url}\n` +
						`Summary: ${result.snippet}\n\n`,
				);
				if (result.content) {
					builder.write(`${result.content}\n\n`);
				}
			}

			return builder.ok(`Found ${results.length} search results.`);
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				return builder.error(
					"Search request timed out. The search service may be slow or unavailable.",
				);
			}
			return builder.error(
				`Search request failed: ${err instanceof Error ? err.message : err}. The search service may be unavailable.`,
			);
		}
	}
}
