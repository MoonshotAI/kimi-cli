/**
 * ACP content block conversion — corresponds to Python acp/convert.py
 * Converts between ACP content blocks and internal wire types.
 */

import type {
	ACPContentBlock,
	ContentToolCallContent,
	FileEditToolCallContent,
	TerminalToolCallContent,
	TextContentBlock,
} from "./types.ts";
import type { ContentPart, ToolReturnValue } from "../types.ts";
import type {
	DisplayBlock,
	DiffDisplayBlock,
	TodoDisplayBlock,
} from "../wire/types.ts";
import { logger } from "../utils/logging.ts";

/**
 * Convert ACP content blocks to internal ContentPart array.
 * Corresponds to Python acp_blocks_to_content_parts().
 */
export function acpBlocksToContentParts(
	prompt: ACPContentBlock[],
): ContentPart[] {
	const content: ContentPart[] = [];
	for (const block of prompt) {
		switch (block.type) {
			case "text":
				content.push({ type: "text", text: block.text });
				break;
			case "image":
				content.push({
					type: "image",
					source: {
						type: "base64",
						mediaType: block.mime_type,
						data: block.data,
					},
				});
				break;
			case "embedded_resource": {
				const resource = block.resource;
				if (resource.type === "text") {
					content.push({
						type: "text",
						text: `<resource uri=${JSON.stringify(resource.uri)}>\n${resource.text}\n</resource>`,
					});
				} else {
					logger.warn(`Unsupported embedded resource type: ${resource.type}`);
				}
				break;
			}
			case "resource":
				content.push({
					type: "text",
					text: `<resource_link uri=${JSON.stringify(block.uri)} name=${JSON.stringify(block.name)} />`,
				});
				break;
			default:
				logger.warn(
					`Unsupported prompt content block: ${JSON.stringify(block)}`,
				);
		}
	}
	return content;
}

/**
 * Convert a DisplayBlock to ACP FileEditToolCallContent.
 * Returns null for non-diff blocks.
 * Corresponds to Python display_block_to_acp_content().
 */
export function displayBlockToAcpContent(
	block: DisplayBlock,
): FileEditToolCallContent | null {
	if (block.type === "diff") {
		const diffBlock = block as DiffDisplayBlock;
		return {
			type: "diff",
			path: diffBlock.path,
			old_text: diffBlock.old_text,
			new_text: diffBlock.new_text,
		};
	}
	return null;
}

/**
 * Convert a ToolReturnValue to ACP content list.
 * Corresponds to Python tool_result_to_acp_content().
 */
export function toolResultToAcpContent(
	toolRet: ToolReturnValue,
	shouldHide: boolean = false,
): (
	| ContentToolCallContent
	| FileEditToolCallContent
	| TerminalToolCallContent
)[] {
	if (shouldHide) {
		return [];
	}

	const contents: (
		| ContentToolCallContent
		| FileEditToolCallContent
		| TerminalToolCallContent
	)[] = [];

	// Process display blocks
	if (toolRet.display) {
		for (const block of toolRet.display) {
			const displayBlock = block as DisplayBlock;
			if (displayBlock.type === "acp/hide_output") {
				// Return early to indicate no output should be shown
				return [];
			}
			const content = displayBlockToAcpContent(displayBlock);
			if (content !== null) {
				contents.push(content);
			}
		}
	}

	// Process output
	const output = toolRet.output;
	if (output) {
		contents.push(toTextBlock(output));
	}

	// Fallback to message if no other content
	if (contents.length === 0 && toolRet.message) {
		contents.push(toTextBlock(toolRet.message));
	}

	return contents;
}

function toTextBlock(text: string): ContentToolCallContent {
	return {
		type: "content",
		content: { type: "text", text } as TextContentBlock,
	};
}
