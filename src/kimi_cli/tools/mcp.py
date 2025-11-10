from typing import Any

import fastmcp
import mcp
from fastmcp.client.client import CallToolResult
from fastmcp.client.transports import ClientTransport
from kosong.message import AudioURLPart, ContentPart, ImageURLPart, TextPart
from kosong.tooling import CallableTool, ToolOk, ToolReturnType


class MCPTool[T: ClientTransport](CallableTool):
    def __init__(self, mcp_tool: mcp.Tool, client: fastmcp.Client[T], **kwargs: Any):
        super().__init__(
            name=mcp_tool.name,
            description=mcp_tool.description or "",
            parameters=mcp_tool.inputSchema,
            **kwargs,
        )
        self._mcp_tool = mcp_tool
        self._client = client

    async def __call__(self, *args: Any, **kwargs: Any) -> ToolReturnType:
        async with self._client as client:
            result = await client.call_tool(self._mcp_tool.name, kwargs, timeout=20)
            return convert_tool_result(result)


def convert_tool_result(result: CallToolResult) -> ToolReturnType:
    content: list[ContentPart] = []
    for part in result.content:
        match part:
            case mcp.types.TextContent(text=text):
                content.append(TextPart(text=text))
            case mcp.types.ImageContent(data=data, mimeType=mimeType):
                content.append(
                    ImageURLPart(
                        image_url=ImageURLPart.ImageURL(url=f"data:{mimeType};base64,{data}")
                    )
                )
            case mcp.types.AudioContent(data=data, mimeType=mimeType):
                content.append(
                    AudioURLPart(
                        audio_url=AudioURLPart.AudioURL(url=f"data:{mimeType};base64,{data}")
                    )
                )
            case mcp.types.EmbeddedResource(
                resource=mcp.types.BlobResourceContents(uri=_uri, mimeType=mimeType, blob=blob)
            ):
                mimeType = mimeType or "application/octet-stream"
                if mimeType.startswith("image/"):
                    content.append(
                        ImageURLPart(
                            type="image_url",
                            image_url=ImageURLPart.ImageURL(
                                url=f"data:{mimeType};base64,{blob}",
                            ),
                        )
                    )
                elif mimeType.startswith("audio/"):
                    content.append(
                        AudioURLPart(
                            type="audio_url",
                            audio_url=AudioURLPart.AudioURL(url=f"data:{mimeType};base64,{blob}"),
                        )
                    )
                else:
                    raise ValueError(f"Unsupported mime type: {mimeType}")
            case mcp.types.ResourceLink(uri=uri, mimeType=mimeType, description=_description):
                mimeType = mimeType or "application/octet-stream"
                if mimeType.startswith("image/"):
                    content.append(
                        ImageURLPart(
                            type="image_url",
                            image_url=ImageURLPart.ImageURL(url=str(uri)),
                        )
                    )
                elif mimeType.startswith("audio/"):
                    content.append(
                        AudioURLPart(
                            type="audio_url",
                            audio_url=AudioURLPart.AudioURL(url=str(uri)),
                        )
                    )
                else:
                    raise ValueError(f"Unsupported mime type: {mimeType}")
            case _:
                raise ValueError(f"Unsupported MCP tool result part: {part}")
    return ToolOk(output=content)
