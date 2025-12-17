from __future__ import annotations

import importlib
import inspect
from contextvars import ContextVar
from typing import TYPE_CHECKING, Any

from kosong.message import ToolCall
from kosong.tooling import CallableTool, CallableTool2, HandleResult, Tool, Toolset
from kosong.tooling.simple import SimpleToolset
from loguru import logger

from kimi_cli.tools import SkipThisTool

current_tool_call = ContextVar[ToolCall | None]("current_tool_call", default=None)


def get_current_tool_call_or_none() -> ToolCall | None:
    """
    Get the current tool call or None.
    Expect to be not None when called from a `__call__` method of a tool.
    """
    return current_tool_call.get()


type ToolType = CallableTool | CallableTool2[Any]


class KimiToolset:
    def __init__(self) -> None:
        self._inner = SimpleToolset()

    def add(self, tool: ToolType) -> None:
        self._inner += tool

    @property
    def tools(self) -> list[Tool]:
        return self._inner.tools

    def handle(self, tool_call: ToolCall) -> HandleResult:
        token = current_tool_call.set(tool_call)
        try:
            return self._inner.handle(tool_call)
        finally:
            current_tool_call.reset(token)

    def load_tools(self, tool_paths: list[str], dependencies: dict[type[Any], Any]) -> list[str]:
        """
        Load tools from paths like `kimi_cli.tools.shell:Shell`.

        Returns:

            Bad tool paths that were failed to load.
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
            logger.error("Bad tools: {bad_tools}", bad_tools=bad_tools)
        return bad_tools

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


if TYPE_CHECKING:

    def type_check(kimi_toolset: KimiToolset):
        _: Toolset = kimi_toolset
