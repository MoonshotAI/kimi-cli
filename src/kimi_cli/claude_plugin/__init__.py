"""Claude plugin compatibility layer for Kimi CLI.

Loads local Claude plugin directories at runtime and maps each component
onto the nearest existing Kimi subsystem.  Compatibility is best-effort,
component-scoped, and non-destructive.
"""

from __future__ import annotations

from kimi_cli.claude_plugin.discovery import (
    discover_default_claude_plugin_dirs,
    get_claude_plugins_dir,
    load_claude_plugins,
)
from kimi_cli.claude_plugin.spec import (
    ClaudeAgentSpec,
    ClaudeCommandSpec,
    ClaudePluginBundle,
    ClaudePluginManifest,
    ClaudePluginRuntime,
)

__all__ = [
    "ClaudeAgentSpec",
    "ClaudeCommandSpec",
    "ClaudePluginBundle",
    "ClaudePluginManifest",
    "ClaudePluginRuntime",
    "discover_default_claude_plugin_dirs",
    "get_claude_plugins_dir",
    "load_claude_plugins",
]
