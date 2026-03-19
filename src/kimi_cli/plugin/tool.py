"""Plugin tool wrapper — runs plugin-declared tools as subprocesses."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from kosong.tooling import CallableTool, ToolError, ToolOk
from kosong.tooling.error import ToolRuntimeError
from loguru import logger

from kimi_cli.plugin import PluginToolSpec
from kimi_cli.wire.types import ToolReturnValue


class PluginTool(CallableTool):
    """A tool that executes a plugin command in a subprocess.

    Parameters are passed via stdin as JSON.
    stdout is captured as the tool result.
    """

    def __init__(
        self,
        tool_spec: PluginToolSpec,
        plugin_dir: Path,
        **kwargs: Any,
    ):
        super().__init__(
            name=tool_spec.name,
            description=tool_spec.description,
            parameters=tool_spec.parameters or {"type": "object", "properties": {}},
            **kwargs,
        )
        self._command = tool_spec.command
        self._plugin_dir = plugin_dir

    async def __call__(self, *args: Any, **kwargs: Any) -> ToolReturnValue:
        params_json = json.dumps(kwargs, ensure_ascii=False)

        try:
            proc = await asyncio.create_subprocess_exec(
                *self._command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(self._plugin_dir),
            )
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(input=params_json.encode("utf-8")),
                timeout=120,
            )
        except TimeoutError:
            return ToolError(
                message=f"Plugin tool '{self.name}' timed out after 120s.",
                brief="Timeout",
            )
        except Exception as exc:
            return ToolRuntimeError(str(exc))

        output = stdout.decode("utf-8", errors="replace").strip()
        err_output = stderr.decode("utf-8", errors="replace").strip()

        if proc.returncode != 0:
            error_msg = err_output or output or f"Exit code {proc.returncode}"
            return ToolError(
                message=f"Plugin tool '{self.name}' failed: {error_msg}",
                brief=f"Exit {proc.returncode}",
            )

        if err_output:
            logger.debug("Plugin tool {name} stderr: {err}", name=self.name, err=err_output)

        return ToolOk(output=output)


def load_plugin_tools(plugins_dir: Path) -> list[PluginTool]:
    """Scan installed plugins and create PluginTool instances for declared tools."""
    from kimi_cli.plugin import PLUGIN_JSON, PluginError, parse_plugin_json

    if not plugins_dir.is_dir():
        return []

    tools: list[PluginTool] = []
    for child in sorted(plugins_dir.iterdir()):
        plugin_json = child / PLUGIN_JSON
        if not child.is_dir() or not plugin_json.is_file():
            continue
        try:
            spec = parse_plugin_json(plugin_json)
        except PluginError:
            continue
        for tool_spec in spec.tools:
            tools.append(PluginTool(tool_spec, plugin_dir=child))
            logger.info(
                "Loaded plugin tool: {name} (from {plugin})",
                name=tool_spec.name,
                plugin=spec.name,
            )
    return tools
