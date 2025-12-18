from __future__ import annotations

import asyncio
import importlib
import inspect
import json
from contextvars import ContextVar
from typing import TYPE_CHECKING, Any

from kosong.message import AudioURLPart, ContentPart, ImageURLPart, TextPart, ToolCall
from kosong.tooling import (
    CallableTool,
    CallableTool2,
    HandleResult,
    Tool,
    ToolError,
    ToolOk,
    ToolResult,
    ToolReturnValue,
    Toolset,
)
from kosong.tooling.error import (
    ToolNotFoundError,
    ToolParseError,
    ToolRuntimeError,
)
from kosong.utils.typing import JsonType
from loguru import logger
from pydantic import BaseModel

from kimi_cli.exception import InvalidToolError, MCPRuntimeError
from kimi_cli.tools import SkipThisTool
from kimi_cli.tools.utils import ToolRejectedError

if TYPE_CHECKING:
    import fastmcp
    import mcp
    from fastmcp.client.client import CallToolResult
    from fastmcp.client.transports import ClientTransport
    from fastmcp.mcp_config import MCPConfig

    from kimi_cli.soul.agent import Runtime

current_tool_call = ContextVar[ToolCall | None]("current_tool_call", default=None)


def get_current_tool_call_or_none() -> ToolCall | None:
    """
    Get the current tool call or None.
    Expect to be not None when called from a `__call__` method of a tool.
    """
    return current_tool_call.get()


type ToolType = CallableTool | CallableTool2[BaseModel]


if TYPE_CHECKING:

    def type_check(kimi_toolset: KimiToolset):
        _: Toolset = kimi_toolset


class KimiToolset:
    def __init__(self) -> None:
        self._tool_dict: dict[str, ToolType] = {}

    def add(self, tool: ToolType) -> None:
        self._tool_dict[tool.name] = tool

    @property
    def tools(self) -> list[Tool]:
        return [tool.base for tool in self._tool_dict.values()]

    def handle(self, tool_call: ToolCall) -> HandleResult:
        token = current_tool_call.set(tool_call)
        try:
            if tool_call.function.name not in self._tool_dict:
                return ToolResult(
                    tool_call_id=tool_call.id,
                    return_value=ToolNotFoundError(tool_call.function.name),
                )

            tool = self._tool_dict[tool_call.function.name]

            try:
                arguments: JsonType = json.loads(tool_call.function.arguments or "{}")
            except json.JSONDecodeError as e:
                return ToolResult(tool_call_id=tool_call.id, return_value=ToolParseError(str(e)))

            async def _call():
                try:
                    ret = await tool.call(arguments)
                    return ToolResult(tool_call_id=tool_call.id, return_value=ret)
                except Exception as e:
                    return ToolResult(
                        tool_call_id=tool_call.id, return_value=ToolRuntimeError(str(e))
                    )

            return asyncio.create_task(_call())
        finally:
            current_tool_call.reset(token)

    def load_tools(self, tool_paths: list[str], dependencies: dict[type[Any], Any]) -> None:
        """
        Load tools from paths like `kimi_cli.tools.shell:Shell`.

        Raises:
            InvalidToolError(KimiCLIException, ValueError): When any tool cannot be loaded.
        """

        good_tools: list[str] = []
        bad_tools: list[str] = []

        for tool_path in tool_paths:
            try:
                tool = self._load_tool(tool_path, dependencies)
            except SkipThisTool:
                logger.info("Skipping tool: {tool_path}", tool_path=tool_path)
                continue
            if tool:
                self.add(tool)
                good_tools.append(tool_path)
            else:
                bad_tools.append(tool_path)
        logger.info("Loaded tools: {good_tools}", good_tools=good_tools)
        if bad_tools:
            raise InvalidToolError(f"Invalid tools: {bad_tools}")

    @staticmethod
    def _load_tool(tool_path: str, dependencies: dict[type[Any], Any]) -> ToolType | None:
        logger.debug("Loading tool: {tool_path}", tool_path=tool_path)
        module_name, class_name = tool_path.rsplit(":", 1)
        try:
            module = importlib.import_module(module_name)
        except ImportError:
            return None
        tool_cls = getattr(module, class_name, None)
        if tool_cls is None:
            return None
        args: list[Any] = []
        if "__init__" in tool_cls.__dict__:
            # the tool class overrides the `__init__` of base class
            for param in inspect.signature(tool_cls).parameters.values():
                if param.kind == inspect.Parameter.KEYWORD_ONLY:
                    # once we encounter a keyword-only parameter, we stop injecting dependencies
                    break
                # all positional parameters should be dependencies to be injected
                if param.annotation not in dependencies:
                    raise ValueError(f"Tool dependency not found: {param.annotation}")
                args.append(dependencies[param.annotation])
        return tool_cls(*args)

    async def load_mcp_tools(self, mcp_configs: list[MCPConfig], runtime: Runtime) -> None:
        """
        Load MCP tools from specified MCP configs.

        Raises:
            MCPRuntimeError(KimiCLIException, RuntimeError): When any MCP server cannot be
                connected.
        """
        import fastmcp

        for mcp_config in mcp_configs:
            # Skip empty MCP configs (no servers defined)
            if not mcp_config.mcpServers:
                logger.debug("Skipping empty MCP config: {mcp_config}", mcp_config=mcp_config)
                continue

            logger.info("Loading MCP tools from: {mcp_config}", mcp_config=mcp_config)
            client = fastmcp.Client(mcp_config)
            try:
                async with client:
                    for tool in await client.list_tools():
                        self.add(MCPTool(tool, client, runtime=runtime))
            except RuntimeError as e:
                raise MCPRuntimeError(f"Failed to load MCP tools: {e}") from e


class MCPTool[T: ClientTransport](CallableTool):
    def __init__(
        self,
        mcp_tool: mcp.Tool,
        client: fastmcp.Client[T],
        *,
        runtime: Runtime,
        **kwargs: Any,
    ):
        super().__init__(
            name=mcp_tool.name,
            description=mcp_tool.description or "",
            parameters=mcp_tool.inputSchema,
            **kwargs,
        )
        self._mcp_tool = mcp_tool
        self._client = client
        self._runtime = runtime
        self._action_name = f"mcp:{mcp_tool.name}"

    async def __call__(self, *args: Any, **kwargs: Any) -> ToolReturnValue:
        description = f"Call MCP tool `{self._mcp_tool.name}`."
        if not await self._runtime.approval.request(self.name, self._action_name, description):
            return ToolRejectedError()

        async with self._client as client:
            result = await client.call_tool(
                self._mcp_tool.name, kwargs, timeout=60, raise_on_error=False
            )
            return convert_mcp_tool_result(result)


def convert_mcp_tool_result(result: CallToolResult) -> ToolReturnValue:
    import mcp

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
    if result.is_error:
        return ToolError(
            output=content,
            message="Tool returned an error. The output may be error message or incomplete output",
            brief="",
        )
    else:
        return ToolOk(output=content)
