"""CLI for hooks-ref library."""

import json
import sys
from pathlib import Path

import click

from .discovery import discover_hooks_in_dir, load_hooks, load_hooks_by_trigger
from .errors import HookError
from .parser import read_properties
from .validator import validate


def _is_hook_md_file(path: Path) -> bool:
    """Check if path points directly to a HOOK.md or hook.md file."""
    return path.is_file() and path.name.lower() == "hook.md"


@click.group()
@click.version_option()
def main():
    """Reference library for Agent Hooks."""
    pass


@main.command("validate")
@click.argument("hook_path", type=click.Path(exists=True, path_type=Path))
def validate_cmd(hook_path: Path):
    """Validate a hook directory.

    Checks that the hook has a valid HOOK.md with proper frontmatter,
    correct naming conventions, and required fields.

    Exit codes:
        0: Valid hook
        1: Validation errors found
    """
    if _is_hook_md_file(hook_path):
        hook_path = hook_path.parent

    result = validate(hook_path)

    if not result.valid:
        click.echo(f"Validation failed for {hook_path}:", err=True)
        for error in result.errors:
            click.echo(f"  - {error}", err=True)
        sys.exit(1)
    else:
        click.echo(f"Valid hook: {hook_path}")


@main.command("read-properties")
@click.argument("hook_path", type=click.Path(exists=True, path_type=Path))
def read_properties_cmd(hook_path: Path):
    """Read and print hook properties as JSON.

    Parses the YAML frontmatter from HOOK.md and outputs the
    properties as JSON.

    Exit codes:
        0: Success
        1: Parse error
    """
    try:
        if _is_hook_md_file(hook_path):
            hook_path = hook_path.parent

        props = read_properties(hook_path)
        click.echo(json.dumps(props.to_dict(), indent=2))
    except HookError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@main.command("list")
@click.option(
    "--project-dir",
    "-p",
    type=click.Path(path_type=Path),
    default=None,
    help="Project directory (default: current directory)",
)
@click.option(
    "--trigger",
    "-t",
    type=str,
    default=None,
    help="Filter by trigger type",
)
def list_cmd(project_dir: Optional[Path], trigger: Optional[str]):
    """List all discovered hooks.

    Discovers hooks from user-level (~/.config/agents/hooks/)
    and project-level (.agents/hooks/) directories.
    """
    try:
        if trigger:
            hooks = load_hooks_by_trigger(trigger, project_dir)
        else:
            hooks = load_hooks(project_dir)

        if not hooks:
            click.echo("No hooks found.")
            return

        click.echo(f"Found {len(hooks)} hook(s):")
        click.echo()

        for hook in hooks:
            click.echo(f"  {hook.name}")
            click.echo(f"    Description: {hook.description}")
            click.echo(f"    Trigger: {hook.trigger.value}")
            click.echo(f"    Priority: {hook.priority}")
            click.echo(f"    Async: {hook.async_}")
            if hook.matcher:
                if hook.matcher.tool:
                    click.echo(f"    Matcher tool: {hook.matcher.tool}")
                if hook.matcher.pattern:
                    click.echo(f"    Matcher pattern: {hook.matcher.pattern}")
            click.echo()

    except HookError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@main.command("to-prompt")
@click.argument(
    "hook_paths", type=click.Path(exists=True, path_type=Path), nargs=-1, required=True
)
def to_prompt_cmd(hook_paths: tuple[Path, ...]):
    """Generate <available_hooks> XML for agent prompts.

    Accepts one or more hook directories.

    Exit codes:
        0: Success
        1: Error
    """
    try:
        from .prompt import to_prompt

        resolved_paths = []
        for hook_path in hook_paths:
            if _is_hook_md_file(hook_path):
                resolved_paths.append(hook_path.parent)
            else:
                resolved_paths.append(hook_path)

        output = to_prompt(resolved_paths)
        click.echo(output)
    except HookError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@main.command("discover")
@click.option(
    "--project-dir",
    "-p",
    type=click.Path(path_type=Path),
    default=None,
    help="Project directory (default: current directory)",
)
@click.option("--json", "-j", "output_json", is_flag=True, help="Output as JSON")
def discover_cmd(project_dir: Optional[Path], output_json: bool):
    """Discover hooks in default locations.

    Shows hooks found in user-level (~/.config/agents/hooks/)
    and project-level (.agents/hooks/) directories.
    """
    from .discovery import discover_all_hooks

    discovered = discover_all_hooks(project_dir)

    if output_json:
        output = {
            "user": [str(p) for p in discovered["user"]],
            "project": [str(p) for p in discovered["project"]],
        }
        click.echo(json.dumps(output, indent=2))
    else:
        user_dir = Path.home() / ".config" / "agents" / "hooks"
        proj_dir = (project_dir or Path.cwd()) / ".agents" / "hooks"

        click.echo(f"User-level hooks ({user_dir}):")
        if discovered["user"]:
            for hook_dir in discovered["user"]:
                click.echo(f"  - {hook_dir.name}")
        else:
            click.echo("  (none)")

        click.echo()
        click.echo(f"Project-level hooks ({proj_dir}):")
        if discovered["project"]:
            for hook_dir in discovered["project"]:
                click.echo(f"  - {hook_dir.name}")
        else:
            click.echo("  (none)")


if __name__ == "__main__":
    main()
