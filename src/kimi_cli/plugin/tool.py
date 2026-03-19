"""Plugin tool wrapper — runs plugin-declared tools as subprocesses."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any

from kosong.tooling import CallableTool, ToolError, ToolOk
from kosong.tooling.error import ToolRuntimeError
from loguru import logger

from kimi_cli.plugin import PluginToolSpec
from kimi_cli.tools.utils import ToolRejectedError
from kimi_cli.wire.types import ToolReturnValue

if TYPE_CHECKING:
    from kimi_cli.config import Config
    from kimi_cli.soul.approval import Approval


def _get_host_values(config: Config) -> dict[str, str]:
    """Extract current host values (api_key, base_url) from config.

    Reads the latest provider credentials, which may have been
    refreshed by OAuth since plugin install time.
    """
    values: dict[str, str] = {}
    if config.default_model and config.default_model in config.models:
        model = config.models[config.default_model]
        if model.provider in config.providers:
            provider = config.providers[model.provider]
            values["api_key"] = provider.api_key.get_secret_value()
            values["base_url"] = provider.base_url
    return values


class PluginTool(CallableTool):
    """A tool that executes a plugin command in a subprocess.

    Parameters are passed via stdin as JSON.
    stdout is captured as the tool result.
    Host credentials are injected as environment variables at runtime
    (not baked into config files) to handle OAuth token refresh.
    """

    def __init__(
        self,
        tool_spec: PluginToolSpec,
        plugin_dir: Path,
        *,
        inject: dict[str, str],
        config: Config,
        approval: Approval | None = None,
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
        self._inject = inject  # e.g. {"kimiCodeAPIKey": "api_key"}
        self._config = config
        self._approval = approval

    def _build_env(self) -> dict[str, str]:
        """Build env vars with fresh host credentials for the subprocess."""
        env = dict(os.environ)
        if self._inject:
            host_values = _get_host_values(self._config)
            for target_key, source_key in self._inject.items():
                if source_key in host_values:
                    # Inject as env var using the plugin's config key name
                    # e.g. kimiCodeAPIKey=<fresh api_key>
                    env[target_key] = host_values[source_key]
        return env

    async def __call__(self, *args: Any, **kwargs: Any) -> ToolReturnValue:
        if self._approval is not None:
            description = f"Run plugin tool `{self.name}`."
            if not await self._approval.request(self.name, f"plugin:{self.name}", description):
                return ToolRejectedError()

        params_json = json.dumps(kwargs, ensure_ascii=False)

        try:
            proc = await asyncio.create_subprocess_exec(
                *self._command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(self._plugin_dir),
                env=self._build_env(),
            )
        except Exception as exc:
            return ToolRuntimeError(str(exc))

        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(input=params_json.encode("utf-8")),
                timeout=120,
            )
        except TimeoutError:
            proc.kill()
            await proc.wait()
            return ToolError(
                message=f"Plugin tool '{self.name}' timed out after 120s.",
                brief="Timeout",
            )

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


def load_plugin_tools(
    plugins_dir: Path, config: Config, *, approval: Approval | None = None
) -> list[PluginTool]:
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
            tools.append(
                PluginTool(
                    tool_spec,
                    plugin_dir=child,
                    inject=spec.inject,
                    config=config,
                    approval=approval,
                )
            )
            logger.info(
                "Loaded plugin tool: {name} (from {plugin})",
                name=tool_spec.name,
                plugin=spec.name,
            )
    return tools
