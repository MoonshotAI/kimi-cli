"""AgentHooks implementation for Kimi CLI.

This module provides support for the AgentHooks standard, allowing users to
define hooks as external scripts in HOOK.md files.
"""

from kimi_cli.hooks.discovery import DiscoveryPaths, HookDiscovery
from kimi_cli.hooks.display import build_hooks_display
from kimi_cli.hooks.executor import ExecutionResult, HookExecutor, HooksExecutionResult
from kimi_cli.hooks.manager import HookDebugger, HookDebugLog, HookManager
from kimi_cli.hooks.parser import HookMetadata, HookParser, Matcher, ParsedHook

__all__ = [
    # Discovery
    "HookDiscovery",
    "DiscoveryPaths",
    # Parser
    "HookParser",
    "ParsedHook",
    "HookMetadata",
    "Matcher",
    # Executor
    "HookExecutor",
    "ExecutionResult",
    # Manager
    "HookManager",
    "HookDebugger",
    "HookDebugLog",
    "HooksExecutionResult",
    # Display
    "build_hooks_display",
]
