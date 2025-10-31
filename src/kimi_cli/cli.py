import asyncio
import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal, get_args

import click

from kimi_cli.constant import VERSION


class Reload(Exception):
    """Reload configuration."""

    pass


UIMode = Literal["shell", "print", "acp"]
InputFormat = Literal["text", "stream-json"]
OutputFormat = Literal["text", "stream-json"]


@click.command(context_settings=dict(help_option_names=["-h", "--help"]))
@click.version_option(VERSION)
@click.option(
    "--verbose",
    is_flag=True,
    default=False,
    help="Print verbose information. Default: no.",
)
@click.option(
    "--debug",
    is_flag=True,
    default=False,
    help="Log debug information. Default: no.",
)
@click.option(
    "--agent-file",
    type=click.Path(exists=True, file_okay=True, dir_okay=False, path_type=Path),
    default=None,
    help="Custom agent specification file. Default: builtin default agent.",
)
@click.option(
    "--model",
    "-m",
    "model_name",
    type=str,
    default=None,
    help="LLM model to use. Default: default model set in config file.",
)
@click.option(
    "--work-dir",
    "-w",
    type=click.Path(exists=True, file_okay=False, dir_okay=True, path_type=Path),
    default=Path.cwd(),
    help="Working directory for the agent. Default: current directory.",
)
@click.option(
    "--continue",
    "-C",
    "continue_",
    is_flag=True,
    default=False,
    help="Continue the previous session for the working directory. Default: no.",
)
@click.option(
    "--command",
    "-c",
    "--query",
    "-q",
    "command",
    type=str,
    default=None,
    help="User query to the agent. Default: prompt interactively.",
)
@click.option(
    "--ui",
    "ui",
    type=click.Choice(get_args(UIMode)),
    default="shell",
    help="UI mode to use. Default: shell.",
)
@click.option(
    "--print",
    "ui",
    flag_value="print",
    help="Run in print mode. Shortcut for `--ui print`. Note: print mode implicitly adds `--yolo`.",
)
@click.option(
    "--acp",
    "ui",
    flag_value="acp",
    help="Start ACP server. Shortcut for `--ui acp`.",
)
@click.option(
    "--input-format",
    type=click.Choice(get_args(InputFormat)),
    default=None,
    help=(
        "Input format to use. Must be used with `--print` "
        "and the input must be piped in via stdin. "
        "Default: text."
    ),
)
@click.option(
    "--output-format",
    type=click.Choice(get_args(OutputFormat)),
    default=None,
    help="Output format to use. Must be used with `--print`. Default: text.",
)
@click.option(
    "--mcp-config-file",
    type=click.Path(exists=True, file_okay=True, dir_okay=False, path_type=Path),
    multiple=True,
    help=(
        "MCP config file to load. Add this option multiple times to specify multiple MCP configs. "
        "Default: none."
    ),
)
@click.option(
    "--mcp-config",
    type=str,
    multiple=True,
    help=(
        "MCP config JSON to load. Add this option multiple times to specify multiple MCP configs. "
        "Default: none."
    ),
)
@click.option(
    "--yolo",
    "--yes",
    "-y",
    "--auto-approve",
    "yolo",
    is_flag=True,
    default=False,
    help="Automatically approve all actions. Default: no.",
)
def kimi(
    verbose: bool,
    debug: bool,
    agent_file: Path | None,
    model_name: str | None,
    work_dir: Path,
    continue_: bool,
    command: str | None,
    ui: UIMode,
    input_format: InputFormat | None,
    output_format: OutputFormat | None,
    mcp_config_file: list[Path],
    mcp_config: list[str],
    yolo: bool,
):
    """Kimi, your next CLI agent."""
    from kimi_cli.app import KimiCLI
    from kimi_cli.session import Session
    from kimi_cli.share import get_share_dir
    from kimi_cli.utils.logging import logger

    def _noop_echo(*args: Any, **kwargs: Any):
        pass

    echo: Callable[..., None] = click.echo if verbose else _noop_echo

    logger.add(
        get_share_dir() / "logs" / "kimi.log",
        level="DEBUG" if debug else "INFO",
        rotation="06:00",
        retention="10 days",
    )

    work_dir = work_dir.absolute()
    if continue_:
        session = Session.continue_(work_dir)
        if session is None:
            raise click.BadOptionUsage(
                "--continue", "No previous session found for the working directory"
            )
        echo(f"✓ Continuing previous session: {session.id}")
    else:
        session = Session.create(work_dir)
        echo(f"✓ Created new session: {session.id}")
    echo(f"✓ Session history file: {session.history_file}")

    if command is not None:
        command = command.strip()
        if not command:
            raise click.BadOptionUsage("--command", "Command cannot be empty")

    if input_format is not None and ui != "print":
        raise click.BadOptionUsage(
            "--input-format",
            "Input format is only supported for print UI",
        )
    if output_format is not None and ui != "print":
        raise click.BadOptionUsage(
            "--output-format",
            "Output format is only supported for print UI",
        )

    try:
        mcp_configs = [json.loads(conf.read_text(encoding="utf-8")) for conf in mcp_config_file]
    except json.JSONDecodeError as e:
        raise click.BadOptionUsage("--mcp-config-file", f"Invalid JSON: {e}") from e

    try:
        mcp_configs += [json.loads(conf) for conf in mcp_config]
    except json.JSONDecodeError as e:
        raise click.BadOptionUsage("--mcp-config", f"Invalid JSON: {e}") from e

    async def _run() -> bool:
        instance = await KimiCLI.create(
            session,
            yolo=yolo or (ui == "print"),  # print mode implies yolo
            stream=ui != "print",  # use non-streaming mode only for print UI
            mcp_configs=mcp_configs,
            model_name=model_name,
            agent_file=agent_file,
        )
        match ui:
            case "shell":
                return await instance.run_shell_mode(command)
            case "print":
                return await instance.run_print_mode(
                    input_format or "text",
                    output_format or "text",
                    command,
                )
            case "acp":
                if command is not None:
                    logger.warning("ACP server ignores command argument")
                return await instance.run_acp_server()

    while True:
        try:
            succeeded = asyncio.run(_run())
            if not succeeded:
                sys.exit(1)
            break
        except Reload:
            continue


def main():
    kimi()


if __name__ == "__main__":
    main()
