from __future__ import annotations

import acp
from kosong.message import (
    ContentPart,
    ImageURLPart,
    TextPart,
)
from kosong.tooling import ToolReturnValue

from kimi_cli.acp.types import ACPContentBlock
from kimi_cli.utils.logging import logger
from kimi_cli.wire.display import DiffDisplayBlock, DisplayBlock


def acp_blocks_to_content_parts(prompt: list[ACPContentBlock]) -> list[ContentPart]:
    content: list[ContentPart] = []
    for block in prompt:
        match block:
            case acp.schema.TextContentBlock():
                content.append(TextPart(text=block.text))
            case acp.schema.ImageContentBlock():
                content.append(
                    ImageURLPart(
                        image_url=ImageURLPart.ImageURL(
                            url=f"data:{block.mime_type};base64,{block.data}"
                        )
                    )
                )
            case _:
                logger.warning("Unsupported prompt content block: {block}", block=block)
    return content


def display_block_to_acp_content(
    block: DisplayBlock,
) -> acp.schema.FileEditToolCallContent | None:
    if isinstance(block, DiffDisplayBlock):
        return acp.schema.FileEditToolCallContent(
            type="diff",
            path=block.path,
            old_text=block.old_text,
            new_text=block.new_text,
        )

    return None


def tool_result_to_acp_content(
    tool_ret: ToolReturnValue,
) -> list[
    acp.schema.ContentToolCallContent
    | acp.schema.FileEditToolCallContent
    | acp.schema.TerminalToolCallContent
]:
    def _to_acp_content(
        part: ContentPart,
    ) -> (
        acp.schema.ContentToolCallContent
        | acp.schema.FileEditToolCallContent
        | acp.schema.TerminalToolCallContent
    ):
        if isinstance(part, TextPart):
            return acp.schema.ContentToolCallContent(
                type="content", content=acp.schema.TextContentBlock(type="text", text=part.text)
            )
        logger.warning("Unsupported content part in tool result: {part}", part=part)
        return acp.schema.ContentToolCallContent(
            type="content",
            content=acp.schema.TextContentBlock(type="text", text=f"[{part.__class__.__name__}]"),
        )

    def _to_text_block(text: str) -> acp.schema.ContentToolCallContent:
        return acp.schema.ContentToolCallContent(
            type="content", content=acp.schema.TextContentBlock(type="text", text=text)
        )

    contents: list[
        acp.schema.ContentToolCallContent
        | acp.schema.FileEditToolCallContent
        | acp.schema.TerminalToolCallContent
    ] = []

    output = tool_ret.output
    if isinstance(output, str):
        if output:
            contents.append(_to_text_block(output))
    else:
        # NOTE: At the moment, ToolReturnValue.output is either a string or a
        # list of ContentPart. We avoid an unnecessary isinstance() check here
        # to keep pyright happy while still handling list outputs.
        contents.extend(_to_acp_content(part) for part in output)

    for block in tool_ret.display:
        content = display_block_to_acp_content(block)
        if content is not None:
            contents.append(content)

    if not contents and tool_ret.message:
        contents.append(_to_text_block(tool_ret.message))

    return contents
