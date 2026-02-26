"""Generate <available_hooks> XML prompt block for agent system prompts."""

import html
from pathlib import Path

from .discovery import load_hooks
from .parser import find_hook_md, read_properties


def to_prompt(hook_dirs: list[Path]) -> str:
    """Generate the <available_hooks> XML block for inclusion in agent prompts.

    This XML format is recommended for agent models to understand
    available hooks and their triggers.

    Args:
        hook_dirs: List of paths to hook directories

    Returns:
        XML string with <available_hooks> block containing each hook's
        name, description, trigger, and location.

    Example output:
        <available_hooks>
        <hook>
        <name>block-dangerous-commands</name>
        <description>Blocks dangerous shell commands</description>
        <trigger>before_tool</trigger>
        <location>/path/to/block-dangerous-commands/HOOK.md</location>
        </hook>
        </available_hooks>
    """
    if not hook_dirs:
        return "<available_hooks>\n</available_hooks>"

    lines = ["<available_hooks>"]

    for hook_dir in hook_dirs:
        hook_dir = Path(hook_dir).resolve()
        props = read_properties(hook_dir)

        lines.append("<hook>")
        lines.append("<name>")
        lines.append(html.escape(props.name))
        lines.append("</name>")
        lines.append("<description>")
        lines.append(html.escape(props.description))
        lines.append("</description>")
        lines.append("<trigger>")
        lines.append(html.escape(props.trigger.value))
        lines.append("</trigger>")

        hook_md_path = find_hook_md(hook_dir)
        lines.append("<location>")
        lines.append(str(hook_md_path))
        lines.append("</location>")

        if props.matcher:
            lines.append("<matcher>")
            if props.matcher.tool:
                lines.append("<tool>")
                lines.append(html.escape(props.matcher.tool))
                lines.append("</tool>")
            if props.matcher.pattern:
                lines.append("<pattern>")
                lines.append(html.escape(props.matcher.pattern))
                lines.append("</pattern>")
            lines.append("</matcher>")

        lines.append("</hook>")

    lines.append("</available_hooks>")

    return "\n".join(lines)


def to_prompt_from_project(project_dir: Optional[Path] = None) -> str:
    """Generate prompt from discovered hooks.

    Args:
        project_dir: Project directory (default: current directory)

    Returns:
        XML string with <available_hooks> block
    """
    hooks = load_hooks(project_dir)

    if not hooks:
        return "<available_hooks>\n</available_hooks>"

    lines = ["<available_hooks>"]

    for props in hooks:
        lines.append("<hook>")
        lines.append("<name>")
        lines.append(html.escape(props.name))
        lines.append("</name>")
        lines.append("<description>")
        lines.append(html.escape(props.description))
        lines.append("</description>")
        lines.append("<trigger>")
        lines.append(html.escape(props.trigger.value))
        lines.append("</trigger>")
        lines.append("</hook>")

    lines.append("</available_hooks>")

    return "\n".join(lines)


# Import for type hints
from typing import Optional
