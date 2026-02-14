from __future__ import annotations

import asyncio
import contextlib
import importlib
import inspect
import json
import time
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal, overload

from kosong.tooling import (
    CallableTool,
    CallableTool2,
    HandleResult,
    Tool,
    ToolError,
    ToolOk,
    Toolset,
)
from kosong.tooling.error import (
    ToolNotFoundError,
    ToolParseError,
    ToolRuntimeError,
)
from kosong.tooling.mcp import convert_mcp_content
from kosong.utils.typing import JsonType
from loguru import logger

from kimi_cli.exception import InvalidToolError, MCPRuntimeError
# Hooks are handled externally via AgentHooks standard
from kimi_cli.tools import SkipThisTool
from kimi_cli.tools.utils import ToolRejectedError
from kimi_cli.wire.types import (
    ContentPart,
    ToolCall,
    ToolCallRequest,
    ToolResult,
    ToolReturnValue,
)

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


type ToolType = CallableTool | CallableTool2[Any]


if TYPE_CHECKING:

    def type_check(kimi_toolset: KimiToolset):
        _: Toolset = kimi_toolset


@dataclass
class ToolHookStats:
    """Statistics for tool hook execution."""

    total_calls: int = 0
    blocked_calls: int = 0
    modified_calls: int = 0

    total_duration_ms: float = 0.0

    @property
    def avg_duration_ms(self) -> float:
        """Average hook execution duration."""
        if self.total_calls == 0:
            return 0.0
        return self.total_duration_ms / self.total_calls


class KimiToolset:
    def __init__(self, runtime: Runtime | None = None) -> None:
        self._tool_dict: dict[str, ToolType] = {}
        self._mcp_servers: dict[str, MCPServerInfo] = {}
        self._mcp_loading_task: asyncio.Task[None] | None = None
        self._runtime = runtime
        self._hook_stats = ToolHookStats()

    def add(self, tool: ToolType) -> None:
        self._tool_dict[tool.name] = tool

    @overload
    def find(self, tool_name_or_type: str) -> ToolType | None: ...
    @overload
    def find[T: ToolType](self, tool_name_or_type: type[T]) -> T | None: ...
    def find(self, tool_name_or_type: str | type[ToolType]) -> ToolType | None:
        if isinstance(tool_name_or_type, str):
            return self._tool_dict.get(tool_name_or_type)
        else:
            for tool in self._tool_dict.values():
                if isinstance(tool, tool_name_or_type):
                    return tool
        return None

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

            # Create async task that handles hooks + tool execution
            async def _call_with_hooks():
                start_time = time.monotonic()
                tool_name = tool_call.function.name
                tool_use_id = tool_call.id
                tool_input = arguments

                try:
                    # Execute pre-tool-call hooks
                    hook_result = await self._execute_pre_tool_call_hooks(
                        tool_name=tool_name,
                        tool_input=tool_input,
                        tool_use_id=tool_use_id,
                    )

                    if hook_result is not None:
                        # Hook blocked the tool execution
                        return hook_result

                    # Execute the actual tool
                    try:
                        ret = await tool.call(tool_input)
                        tool_output = ret
                        error = None
                    except Exception as e:
                        tool_output = None
                        error = str(e)
                        ret = ToolRuntimeError(str(e))

                    # Execute post-tool-call hooks (fire and forget for async hooks)
                    await self._execute_post_tool_call_hooks(
                        tool_name=tool_name,
                        tool_input=tool_input,
                        tool_output=tool_output,
                        error=error,
                        tool_use_id=tool_use_id,
                        duration_ms=int((time.monotonic() - start_time) * 1000),
                    )

                    return ToolResult(tool_call_id=tool_call.id, return_value=ret)

                except Exception as e:
                    logger.exception("Tool execution failed: {error}", error=e)
                    return ToolResult(
                        tool_call_id=tool_call.id, return_value=ToolRuntimeError(str(e))
                    )

            return asyncio.create_task(_call_with_hooks())
        finally:
            current_tool_call.reset(token)

    async def _execute_pre_tool_call_hooks(
        self,
        tool_name: str,
        tool_input: dict[str, Any],
        tool_use_id: str,
    ) -> ToolResult | None:
        """Execute pre-tool-call hooks and return blocked result or None to continue.

        Returns:
            ToolResult if tool should be blocked, None to continue execution.
        """
        if self._runtime is None:
            return None

        self._hook_stats.total_calls += 1
        start_time = time.monotonic()

        # Build event context
        event = {
            "event_type": "pre-tool-call",
            "timestamp": datetime.now().isoformat(),
            "session_id": self._runtime.session.id,
            "work_dir": str(self._runtime.session.work_dir),
            "tool_name": tool_name,
            "tool_input": tool_input,
            "tool_use_id": tool_use_id,
        }

        try:
            exec_result = await self._runtime.hook_manager.execute(
                "pre-tool-call",
                event,
                tool_name=tool_name,
                tool_input=tool_input,
            )
        except Exception as e:
            logger.exception("Failed to execute pre-tool-call hooks: {error}", error=e)
            return None
        finally:
            duration_ms = (time.monotonic() - start_time) * 1000
            self._hook_stats.total_duration_ms += duration_ms

        # Check if any hook blocked the execution
        if exec_result.should_block:
            self._hook_stats.blocked_calls += 1
            logger.info(
                "Tool {tool_name} blocked: {reason}",
                tool_name=tool_name,
                reason=exec_result.block_reason,
            )

            return ToolResult(
                tool_call_id=tool_use_id,
                return_value=ToolError(
                    message=f"Tool blocked: {exec_result.block_reason}",
                    brief="Blocked by hook",
                ),
            )

        # Process individual results for logging and stats
        for result in exec_result.results:
            if not result.success:
                logger.warning(
                    "pre-tool-call hook {name} failed: {reason}",
                    name=result.hook_name,
                    reason=result.reason,
                )
                continue

            if result.decision == "ask":
                # TODO: Implement interactive approval for hooks
                logger.warning(
                    "Hook {hook_name} requested ASK decision but interactive approval not implemented yet",
                    hook_name=result.hook_name,
                )

            if result.modified_input is not None:
                self._hook_stats.modified_calls += 1
                logger.debug(
                    "Tool {tool_name} input modified by hook {hook_name}",
                    tool_name=tool_name,
                    hook_name=result.hook_name,
                )
                # Note: Input modification is tricky because we've already parsed arguments
                # For now, we log it but don't apply it. Future: pass modified_input back to tool.call()

        return None

    async def _execute_post_tool_call_hooks(
        self,
        tool_name: str,
        tool_input: dict[str, Any],
        tool_output: Any,
        error: str | None,
        tool_use_id: str,
        duration_ms: int,
    ) -> None:
        """Execute post-tool-call hooks (fire and forget for async hooks)."""
        if self._runtime is None:
            return

        # Build event context
        event = {
            "event_type": "post-tool-call",
            "timestamp": datetime.now().isoformat(),
            "session_id": self._runtime.session.id,
            "work_dir": str(self._runtime.session.work_dir),
            "tool_name": tool_name,
            "tool_input": tool_input,
            "tool_use_id": tool_use_id,
            "tool_output": tool_output,
            "error": error,
            "duration_ms": duration_ms,
        }

        try:
            exec_result = await self._runtime.hook_manager.execute(
                "post-tool-call",
                event,
                tool_name=tool_name,
                tool_input=tool_input,
            )

            # Log results from sync hooks
            for result in exec_result.results:
                if not result.success:
                    logger.warning(
                        "post-tool-call hook {name} failed: {reason}",
                        name=result.hook_name,
                        reason=result.reason,
                    )
                else:
                    logger.debug(
                        "post-tool-call hook {name} executed successfully",
                        name=result.hook_name,
                    )

            # Async hooks are tracked but not awaited here
            if exec_result.async_tasks:
                logger.debug(
                    "{count} async post-tool-call hooks fired",
                    count=len(exec_result.async_tasks),
                )
        except Exception as e:
            logger.exception("Failed to execute post-tool-call hooks: {error}", error=e)

    def get_hook_stats(self) -> ToolHookStats:
        """Get hook execution statistics."""
        return self._hook_stats

    def register_external_tool(
        self,
        name: str,
        description: str,
        parameters: dict[str, Any],
    ) -> tuple[bool, str | None]:
        if name in self._tool_dict:
            existing = self._tool_dict[name]
            if not isinstance(existing, WireExternalTool):
                return False, "tool name conflicts with existing tool"
        try:
            tool = WireExternalTool(
                name=name,
                description=description,
                parameters=parameters,
            )
        except Exception as e:
            return False, str(e)
        self.add(tool)
        return True, None

    @property
    def mcp_servers(self) -> dict[str, MCPServerInfo]:
        """Get MCP servers info."""
        return self._mcp_servers

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

    # TODO(rc): remove `in_background` parameter and always load in background
    async def load_mcp_tools(
        self, mcp_configs: list[MCPConfig], runtime: Runtime, in_background: bool = True
    ) -> None:
        """
        Load MCP tools from specified MCP configs.

        Raises:
            MCPRuntimeError(KimiCLIException, RuntimeError): When any MCP server cannot be
                connected.
        """
        import fastmcp
        from fastmcp.mcp_config import MCPConfig, RemoteMCPServer

        from kimi_cli.ui.shell.prompt import toast

        async def _check_oauth_tokens(server_url: str) -> bool:
            """Check if OAuth tokens exist for the server."""
            try:
                from fastmcp.client.auth.oauth import FileTokenStorage

                storage = FileTokenStorage(server_url=server_url)
                tokens = await storage.get_tokens()
                return tokens is not None
            except Exception:
                return False

        def _toast_mcp(message: str) -> None:
            if in_background:
                toast(
                    message,
                    duration=10.0,
                    topic="mcp",
                    immediate=True,
                    position="right",
                )

        oauth_servers: dict[str, str] = {}

        async def _connect_server(
            server_name: str, server_info: MCPServerInfo
        ) -> tuple[str, Exception | None]:
            if server_info.status != "pending":
                return server_name, None

            server_info.status = "connecting"
            try:
                async with server_info.client as client:
                    for tool in await client.list_tools():
                        server_info.tools.append(
                            MCPTool(server_name, tool, client, runtime=runtime)
                        )

                for tool in server_info.tools:
                    self.add(tool)

                server_info.status = "connected"
                logger.info("Connected MCP server: {server_name}", server_name=server_name)
                return server_name, None
            except Exception as e:
                logger.error(
                    "Failed to connect MCP server: {server_name}, error: {error}",
                    server_name=server_name,
                    error=e,
                )
                server_info.status = "failed"
                return server_name, e

        async def _connect():
            _toast_mcp("connecting to mcp servers...")
            unauthorized_servers: dict[str, str] = {}
            for server_name, server_info in self._mcp_servers.items():
                server_url = oauth_servers.get(server_name)
                if not server_url:
                    continue
                if not await _check_oauth_tokens(server_url):
                    logger.warning(
                        "Skipping OAuth MCP server '{server_name}': not authorized. "
                        "Run 'kimi mcp auth {server_name}' first.",
                        server_name=server_name,
                    )
                    server_info.status = "unauthorized"
                    unauthorized_servers[server_name] = server_url

            tasks = [
                asyncio.create_task(_connect_server(server_name, server_info))
                for server_name, server_info in self._mcp_servers.items()
                if server_info.status == "pending"
            ]
            results = await asyncio.gather(*tasks) if tasks else []
            failed_servers = {name: error for name, error in results if error is not None}

            for mcp_config in mcp_configs:
                # Skip empty MCP configs (no servers defined)
                if not mcp_config.mcpServers:
                    logger.debug("Skipping empty MCP config: {mcp_config}", mcp_config=mcp_config)
                    continue

            if failed_servers:
                _toast_mcp("mcp connection failed")
                raise MCPRuntimeError(f"Failed to connect MCP servers: {failed_servers}")
            if unauthorized_servers:
                _toast_mcp("mcp authorization needed")
            else:
                _toast_mcp("mcp servers connected")

        for mcp_config in mcp_configs:
            if not mcp_config.mcpServers:
                logger.debug("Skipping empty MCP config: {mcp_config}", mcp_config=mcp_config)
                continue

            for server_name, server_config in mcp_config.mcpServers.items():
                if isinstance(server_config, RemoteMCPServer) and server_config.auth == "oauth":
                    oauth_servers[server_name] = server_config.url

                client = fastmcp.Client(MCPConfig(mcpServers={server_name: server_config}))
                self._mcp_servers[server_name] = MCPServerInfo(
                    status="pending", client=client, tools=[]
                )

        if in_background:
            self._mcp_loading_task = asyncio.create_task(_connect())
        else:
            await _connect()

    async def wait_for_mcp_tools(self) -> None:
        """Wait for background MCP tool loading to finish."""
        task = self._mcp_loading_task
        if not task:
            return
        try:
            await task
        finally:
            if self._mcp_loading_task is task and task.done():
                self._mcp_loading_task = None

    async def cleanup(self) -> None:
        """Cleanup any resources held by the toolset."""
        if self._mcp_loading_task:
            self._mcp_loading_task.cancel()
            with contextlib.suppress(Exception):
                await self._mcp_loading_task
        for server_info in self._mcp_servers.values():
            await server_info.client.close()


@dataclass(slots=True)
class MCPServerInfo:
    status: Literal["pending", "connecting", "connected", "failed", "unauthorized"]
    client: fastmcp.Client[Any]
    tools: list[MCPTool[Any]]


class MCPTool[T: ClientTransport](CallableTool):
    def __init__(
        self,
        server_name: str,
        mcp_tool: mcp.Tool,
        client: fastmcp.Client[T],
        *,
        runtime: Runtime,
        **kwargs: Any,
    ):
        super().__init__(
            name=mcp_tool.name,
            description=(
                f"This is an MCP (Model Context Protocol) tool from MCP server `{server_name}`.\n\n"
                f"{mcp_tool.description or 'No description provided.'}"
            ),
            parameters=mcp_tool.inputSchema,
            **kwargs,
        )
        self._mcp_tool = mcp_tool
        self._client = client
        self._runtime = runtime
        self._timeout = timedelta(milliseconds=runtime.config.mcp.client.tool_call_timeout_ms)
        self._action_name = f"mcp:{mcp_tool.name}"

    async def __call__(self, *args: Any, **kwargs: Any) -> ToolReturnValue:
        description = f"Call MCP tool `{self._mcp_tool.name}`."
        if not await self._runtime.approval.request(self.name, self._action_name, description):
            return ToolRejectedError()

        try:
            async with self._client as client:
                result = await client.call_tool(
                    self._mcp_tool.name,
                    kwargs,
                    timeout=self._timeout,
                    raise_on_error=False,
                )
                return convert_mcp_tool_result(result)
        except Exception as e:
            # fastmcp raises `RuntimeError` on timeout and we cannot tell it from other errors
            exc_msg = str(e).lower()
            if "timeout" in exc_msg or "timed out" in exc_msg:
                return ToolError(
                    message=(
                        f"Timeout while calling MCP tool `{self._mcp_tool.name}`. "
                        "You may explain to the user that the timeout config is set too low."
                    ),
                    brief="Timeout",
                )
            raise


class WireExternalTool(CallableTool):
    def __init__(self, *, name: str, description: str, parameters: dict[str, Any]) -> None:
        super().__init__(
            name=name,
            description=description or "No description provided.",
            parameters=parameters,
        )

    async def __call__(self, *args: Any, **kwargs: Any) -> ToolReturnValue:
        tool_call = get_current_tool_call_or_none()
        if tool_call is None:
            return ToolError(
                message="External tool calls must be invoked from a tool call context.",
                brief="Invalid tool call",
            )

        from kimi_cli.soul import get_wire_or_none

        wire = get_wire_or_none()
        if wire is None:
            logger.error(
                "Wire is not available for external tool call: {tool_name}", tool_name=self.name
            )
            return ToolError(
                message="Wire is not available for external tool calls.",
                brief="Wire unavailable",
            )

        external_tool_call = ToolCallRequest.from_tool_call(tool_call)
        wire.soul_side.send(external_tool_call)
        try:
            return await external_tool_call.wait()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.exception("External tool call failed: {tool_name}:", tool_name=self.name)
            return ToolError(
                message=f"External tool call failed: {e}",
                brief="External tool error",
            )


def convert_mcp_tool_result(result: CallToolResult) -> ToolReturnValue:
    """Convert MCP tool result to kosong tool return value.

    Raises:
        ValueError: If any content part has unsupported type or mime type.
    """
    content: list[ContentPart] = []
    for part in result.content:
        content.append(convert_mcp_content(part))
    if result.is_error:
        return ToolError(
            output=content,
            message="Tool returned an error. The output may be error message or incomplete output",
            brief="",
        )
    else:
        return ToolOk(output=content)
