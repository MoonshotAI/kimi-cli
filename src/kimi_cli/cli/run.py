"""Run command for Kimi Code CLI - run other CLI tools with Kimi backend."""

from __future__ import annotations

import contextlib
import json
import os
import shutil
from pathlib import Path
from typing import Annotated, Any

import typer

from kimi_cli.cli.key_rotation import select_best_key
from kimi_cli.utils.subprocess_env import get_clean_env

cli = typer.Typer(help="Run other CLI tools with Kimi backend.")

# Kimi's native Anthropic-compatible endpoint
_KIMI_ANTHROPIC_BASE_URL = "https://api.kimi.com/coding/"

# Separate config dir to force API key auth (avoiding OAuth)
_CLAUDE_CONFIG_DIR = Path.home() / ".claude-kimigas"

# Path to the bundled CLAUDE.md system prompt
_CLAUDE_SYSTEM_PROMPT_PATH = Path(__file__).parent.parent / "agents" / "claude" / "CLAUDE.md"

# Plugins to pre-install in the kimigas config
_REQUIRED_PLUGINS = {
    "superpowers@claude-plugins-official": True,
    "playwright@claude-plugins-official": True,
    "code-review@claude-plugins-official": True,
    "code-simplifier@claude-plugins-official": True,
    "context7@claude-plugins-official": True,
    "pr-review-toolkit@claude-plugins-official": True,
    "claude-code-setup@claude-plugins-official": True,
    "claude-md-management@claude-plugins-official": True,
    "ralph-loop@claude-plugins-official": True,
    "frontend-design@claude-plugins-official": True,
}


def _setup_kimigas_config(api_key: str) -> None:
    """Set up isolated Claude config dir for API key auth.

    Claude Code interactive mode ignores ANTHROPIC_API_KEY env var, preferring
    OAuth from .credentials.json. To use API key auth, we need a separate config
    dir with:
      1. No OAuth credentials (.credentials.json without claudeAiOauth)
      2. Onboarding marked complete (hasCompletedOnboarding in .claude.json)
      3. API key fingerprint pre-approved (customApiKeyResponses.approved)
    """
    config_dir = _CLAUDE_CONFIG_DIR
    config_dir.mkdir(parents=True, exist_ok=True)

    # Copy essential config from main claude dir if it exists
    main_claude_dir = Path.home() / ".claude"
    if main_claude_dir.exists():
        for f in [".claude.json", "settings.json", "keybindings.json", "stats-cache.json"]:
            src = main_claude_dir / f
            dst = config_dir / f
            if src.exists() and not dst.exists():
                shutil.copy2(src, dst)
        for d in ["skills", "agents", "commands", "plugins"]:
            src = main_claude_dir / d
            dst = config_dir / d
            if src.exists() and not dst.exists():
                shutil.copytree(src, dst, ignore_dangling_symlinks=True)

    # Write empty credentials (no OAuth = forces API key auth)
    creds_file = config_dir / ".credentials.json"
    creds_file.write_text("{}")

    # Patch .claude.json: mark onboarding complete, pre-approve API key
    cfg_file = config_dir / ".claude.json"
    fingerprint = api_key[-20:] if len(api_key) >= 20 else api_key

    cfg: dict[str, Any] = {}
    if cfg_file.exists():
        with contextlib.suppress(json.JSONDecodeError):
            cfg = json.loads(cfg_file.read_text())

    cfg["hasCompletedOnboarding"] = True
    cfg["lastOnboardingVersion"] = "2.1.38"
    cfg["theme"] = cfg.get("theme", "dark")
    cfg["bypassPermissionsModeAccepted"] = True

    # Manage customApiKeyResponses with proper typing
    custom_responses: dict[str, Any] = cfg.get("customApiKeyResponses", {})
    approved: list[str] = custom_responses.get("approved", [])
    if fingerprint not in approved:
        approved.append(fingerprint)
    custom_responses["approved"] = approved
    cfg["customApiKeyResponses"] = custom_responses

    cfg_file.write_text(json.dumps(cfg))

    # Merge required plugins into settings.json (additive only)
    settings_file = config_dir / "settings.json"
    settings: dict[str, Any] = {}
    if settings_file.exists():
        with contextlib.suppress(json.JSONDecodeError):
            settings = json.loads(settings_file.read_text())

    plugins: dict[str, bool] = settings.get("plugins", {})
    for plugin_id, enabled in _REQUIRED_PLUGINS.items():
        if plugin_id not in plugins:
            plugins[plugin_id] = enabled
    settings["plugins"] = plugins
    settings_file.write_text(json.dumps(settings, indent=2))


def _find_claude_binary() -> str | None:
    """Find the claude binary in PATH."""
    return shutil.which("claude")


def _setup_claude_md(work_dir: Path | None) -> Path | None:
    """Set up CLAUDE.md system prompt in the working directory.

    Copies the bundled CLAUDE.md to the working directory if:
      1. The bundled CLAUDE.md exists
      2. No CLAUDE.md already exists in the working directory

    This ensures the agent reads the system prompt first when starting.

    Returns:
        The path to the CLAUDE.md file if created, None otherwise.
    """
    # Determine the target directory
    target_dir = work_dir if work_dir is not None else Path.cwd()

    # Check if bundled CLAUDE.md exists
    if not _CLAUDE_SYSTEM_PROMPT_PATH.exists():
        return None

    # Check if CLAUDE.md already exists in target directory
    target_claude_md = target_dir / "CLAUDE.md"
    if target_claude_md.exists():
        # Don't overwrite existing CLAUDE.md
        return None

    try:
        shutil.copy2(_CLAUDE_SYSTEM_PROMPT_PATH, target_claude_md)
        return target_claude_md
    except OSError:
        # If we can't write (e.g., permission issues), continue without error
        return None


@cli.command(context_settings={"allow_extra_args": True, "ignore_unknown_options": True})
def claude(
    ctx: typer.Context,
    work_dir: Annotated[
        Path | None,
        typer.Option(
            "--work-dir",
            "-w",
            exists=True,
            file_okay=False,
            dir_okay=True,
            readable=True,
            writable=True,
            help="Working directory for Claude Code. Default: current directory.",
        ),
    ] = None,
    yolo: Annotated[
        bool,
        typer.Option(
            "--yolo",
            "--yes",
            "-y",
            "--auto-approve",
            help="Automatically approve all actions. Maps to --dangerously-skip-permissions.",
        ),
    ] = False,
    api_key: Annotated[
        str | None,
        typer.Option(
            "--api-key",
            help="Kimi API key. Defaults to KIMI_API_KEY env var.",
        ),
    ] = None,
    rotate: Annotated[
        bool | None,
        typer.Option(
            "--rotate/--no-rotate",
            help="Enable multi-key rotation. Default: auto (rotate when multiple keys found).",
        ),
    ] = None,
):
    """Run Claude Code with Kimi K2.5 backend.

    This command launches Claude Code but redirects all API calls to Kimi's
    native Anthropic-compatible endpoint (https://api.kimi.com/coding/).
    This gives you Claude Code's interface with Kimi K2.5 as the model.

    Requires:
        - claude: Anthropic's Claude Code CLI (npm install -g @anthropic-ai/claude-code)
        - KIMI_API_KEY environment variable or --api-key option

    Examples:
        kimigas run claude                    # Run Claude Code with Kimi backend
        kimigas run claude --yolo             # Auto-approve all actions
        kimigas run claude -w /path/to/project  # Set working directory
    """
    # Check if claude is installed
    claude_path = _find_claude_binary()
    if claude_path is None:
        typer.echo(
            "Error: Claude Code not found. Install it with:\n"
            "  npm install -g @anthropic-ai/claude-code",
            err=True,
        )
        raise typer.Exit(code=1)

    # Resolve API key — with rotation if multiple keys available
    try:
        kimi_api_key, num_keys = select_best_key(
            explicit_key=api_key,
            state_dir=_CLAUDE_CONFIG_DIR,
        )
    except RuntimeError as e:
        typer.echo(f"Error: {e}", err=True)
        raise typer.Exit(code=1) from None

    # Report rotation status
    use_rotation = rotate if rotate is not None else (num_keys > 1)
    if use_rotation and num_keys > 1:
        typer.echo(f"Key rotation: using 1 of {num_keys} available keys")
    elif num_keys == 1 and rotate is True:
        typer.echo("Key rotation: only 1 key found, rotation disabled")

    # Set up isolated config dir for API key auth
    _setup_kimigas_config(kimi_api_key)

    # Set up CLAUDE.md system prompt in working directory
    claude_md_path = _setup_claude_md(work_dir)
    if claude_md_path is not None:
        typer.echo(f"Loaded system prompt: {claude_md_path}")

    # Build environment
    env = get_clean_env()
    env.update(
        {
            # Redirect to Kimi's Anthropic-compatible endpoint
            "ANTHROPIC_BASE_URL": _KIMI_ANTHROPIC_BASE_URL,
            "ANTHROPIC_API_KEY": kimi_api_key,
            "DISABLE_COST_WARNINGS": "true",
            # Use isolated config dir
            "CLAUDE_CONFIG_DIR": str(_CLAUDE_CONFIG_DIR),
        }
    )

    # Build claude command arguments
    claude_args = [claude_path]

    # Map --yolo to --dangerously-skip-permissions
    if yolo:
        claude_args.append("--dangerously-skip-permissions")

    if work_dir is not None:
        claude_args.extend(["--work-dir", str(work_dir)])

    # Pass through any additional arguments
    claude_args.extend(ctx.args)

    # Launch Claude Code with modified environment
    typer.echo("Launching Claude Code with Kimi K2.5 backend...")

    try:
        # Use os.execvpe to replace current process with claude
        # This ensures proper TTY handling for interactive CLI
        os.execvpe(claude_args[0], claude_args, env)
    except OSError as e:
        typer.echo(f"Error launching Claude Code: {e}", err=True)
        raise typer.Exit(code=1) from None
