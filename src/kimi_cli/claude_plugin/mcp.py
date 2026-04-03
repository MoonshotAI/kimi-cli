"""Translate Claude plugin .mcp.json into runtime-only MCP configs."""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import pydantic

from kimi_cli.utils.logging import logger

from .hooks import expand_plugin_root

if TYPE_CHECKING:
    from .spec import ClaudePluginRuntime


def load_plugin_mcp(runtime: ClaudePluginRuntime) -> None:
    """Parse ``.mcp.json`` and populate *runtime.mcp_configs*.

    The resulting configs are runtime-only and must never be persisted to
    ``~/.kimi/mcp.json``.
    """
    mcp_path = runtime.root / ".mcp.json"
    if not mcp_path.is_file():
        return

    try:
        raw: Any = json.loads(mcp_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        runtime.warnings.append(f"Invalid .mcp.json: {exc}")
        logger.warning(
            "Invalid .mcp.json in plugin '{name}': {error}",
            name=runtime.manifest.name,
            error=exc,
        )
        return

    if not isinstance(raw, dict):
        runtime.warnings.append(".mcp.json root is not a JSON object")
        return
    raw_dict = cast(dict[str, Any], raw)

    servers_raw = raw_dict.get("mcpServers", {})
    if not isinstance(servers_raw, dict):
        runtime.warnings.append(".mcp.json 'mcpServers' is not a dict")
        return
    servers = cast(dict[str, Any], servers_raw)

    plugin_root = runtime.root
    plugin_name = runtime.manifest.name
    from fastmcp.mcp_config import MCPConfig

    expanded_servers: dict[str, Any] = {}
    for server_name, server_config in servers.items():
        if not isinstance(server_config, dict):
            continue

        # Deep-expand ${CLAUDE_PLUGIN_ROOT} in string values
        expanded = _expand_config(server_config, plugin_root)

        # Namespace server name to avoid collisions
        namespaced_name = f"{plugin_name}:{server_name}"
        try:
            MCPConfig.model_validate({"mcpServers": {namespaced_name: expanded}})
        except pydantic.ValidationError as exc:
            runtime.warnings.append(
                f"Skipping MCP server {server_name}: Invalid MCP config: {exc}"
            )
            logger.warning(
                "Skipping invalid Claude plugin MCP server {plugin}:{server}: {error}",
                plugin=plugin_name,
                server=server_name,
                error=exc,
            )
            continue
        expanded_servers[namespaced_name] = expanded

    if expanded_servers:
        runtime.mcp_configs.append({"mcpServers": expanded_servers})
        logger.info(
            "Loaded {count} MCP server(s) from plugin '{plugin}'",
            count=len(expanded_servers),
            plugin=plugin_name,
        )


def _expand_config(config: Any, plugin_root: Path) -> Any:
    """Recursively expand ``${CLAUDE_PLUGIN_ROOT}`` in config values."""
    if isinstance(config, str):
        return expand_plugin_root(config, plugin_root)
    if isinstance(config, dict):
        d = cast(dict[str, Any], config)
        return {k: _expand_config(v, plugin_root) for k, v in d.items()}
    if isinstance(config, list):
        items = cast(list[Any], config)
        return [_expand_config(item, plugin_root) for item in items]
    return config
