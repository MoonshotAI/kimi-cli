"""Display and formatting utilities for AgentHooks."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from kimi_cli.hooks.discovery import DiscoveryPaths
    from kimi_cli.hooks.manager import HookManager
    from kimi_cli.hooks.parser import ParsedHook


def format_hook_info(hook: ParsedHook) -> str:
    """Format a single hook for display."""
    meta = hook.metadata
    mode = "async" if meta.async_ else "sync"

    matcher_info = ""
    if meta.matcher:
        tool = meta.matcher.get("tool", "*")
        pattern = meta.matcher.get("pattern", "*")
        matcher_info = f" [{tool}:{pattern}]"

    info = f"Trigger: {meta.trigger} | Mode: {mode} | Priority: {meta.priority}"
    return f"   • {hook.name}\n     {info}{matcher_info}"


def group_hooks_by_source(
    hooks: list[ParsedHook],
    paths: DiscoveryPaths,
) -> tuple[list[ParsedHook], list[ParsedHook]]:
    """Group hooks by source (project-level vs user-level).

    Returns:
        Tuple of (project_hooks, user_hooks)
    """
    project_hooks: list[ParsedHook] = []
    user_hooks: list[ParsedHook] = []

    for hook in hooks:
        hook_path = Path(hook.path)
        if paths.project_hooks and hook_path.is_relative_to(paths.project_hooks):
            project_hooks.append(hook)
        else:
            user_hooks.append(hook)

    return project_hooks, user_hooks


def format_hook_directories(paths: DiscoveryPaths) -> list[str]:
    """Format hook directory information."""
    lines: list[str] = []
    lines.append("📁 Hook Directories:")
    lines.append(f"   User:   {paths.user_hooks}")
    if paths.project_hooks:
        lines.append(f"   Project: {paths.project_hooks}")
    else:
        lines.append("   Project: (none - create .agents/hooks/ to add project-level hooks)")
    return lines


def format_empty_hooks_state() -> list[str]:
    """Format the 'no hooks found' state with instructions."""
    lines: list[str] = []
    lines.append("No hooks found.")
    lines.append("")
    lines.append("To add hooks, create a directory with HOOK.md and scripts:")
    lines.append("")
    lines.append("  mkdir -p ~/.config/agents/hooks/my-hook/scripts")
    lines.append("  cat > ~/.config/agents/hooks/my-hook/HOOK.md << 'EOF'")
    lines.append("  ---")
    lines.append("  name: my-hook")
    lines.append("  description: My custom hook")
    lines.append("  trigger: pre-tool-call")
    lines.append("  ---")
    lines.append("  EOF")
    lines.append("  echo '#!/bin/bash' > ~/.config/agents/hooks/my-hook/scripts/run.sh")
    lines.append("  chmod +x ~/.config/agents/hooks/my-hook/scripts/run.sh")
    return lines


def format_hook_list(hooks: list[ParsedHook]) -> list[str]:
    """Format a list of hooks for display."""
    return [format_hook_info(hook) for hook in hooks]


def format_hook_statistics(hook_manager: HookManager) -> list[str]:
    """Format hook execution statistics if available."""
    lines: list[str] = []
    stats = hook_manager.get_debug_stats()

    if stats["total_executions"] == 0:
        return lines

    lines.append("📊 Hook Statistics (this session):")
    lines.append(f"   Executions: {stats['total_executions']}")
    successful = stats["successful"]
    failed = stats["failed"]
    blocked = stats["blocked"]
    lines.append(f"   Successful: {successful} | Failed: {failed} | Blocked: {blocked}")
    lines.append(f"   Total duration: {stats['total_duration_ms']}ms")
    lines.append("")
    return lines


def format_management_instructions(has_project_hooks: bool) -> list[str]:
    """Format instructions for managing hooks."""
    lines: list[str] = []
    lines.append("─" * 50)
    lines.append("")
    lines.append("📝 To add, modify or remove hooks, edit the files directly:")
    lines.append("")
    lines.append("  # Add a user-level hook (applies to all projects)")
    lines.append("  mkdir -p ~/.config/agents/hooks/<hook-name>/scripts")
    lines.append("  # Then create HOOK.md and scripts/run[.sh|.py]")
    lines.append("")

    if has_project_hooks:
        lines.append("  # Add a project-level hook (only this project)")
        lines.append("  mkdir -p .agents/hooks/<hook-name>/scripts")
        lines.append("  # Then create HOOK.md and scripts/run[.sh|.py]")
        lines.append("")

    lines.append(
        "📖 Documentation: "
        "https://github.com/moonshot-ai/kimi-cli/blob/main/docs/en/configuration/hooks.md"
    )
    return lines


def build_hooks_display(
    hook_manager: HookManager,
    work_dir: str,
) -> str:
    """Build the complete hooks display output.

    Args:
        hook_manager: The hook manager instance
        work_dir: Current working directory (as string for KaosPath compatibility)

    Returns:
        Formatted display string
    """
    discovery = hook_manager.discovery
    paths = discovery.paths

    lines: list[str] = []
    lines.append("\n🪝 Agent Hooks")
    lines.append("")

    # Hook directories
    lines.extend(format_hook_directories(paths))
    lines.append("")

    # Invalidate cache for fresh discovery
    discovery.invalidate_cache()
    all_hooks = discovery.discover(use_cache=False)

    if not all_hooks:
        lines.extend(format_empty_hooks_state())
        return "\n".join(lines)

    # Group and display hooks
    project_hooks, user_hooks = group_hooks_by_source(all_hooks, paths)

    lines.append(f"📋 Found {len(all_hooks)} hook(s):")
    lines.append("")

    if project_hooks:
        lines.append("🗂️  Project-level hooks (override user-level):")
        lines.extend(format_hook_list(project_hooks))
        lines.append("")

    if user_hooks:
        lines.append("👤 User-level hooks:")
        lines.extend(format_hook_list(user_hooks))
        lines.append("")

    # Statistics
    lines.extend(format_hook_statistics(hook_manager))

    # Management instructions
    lines.extend(format_management_instructions(paths.project_hooks is not None))
    lines.append("")

    return "\n".join(lines)
