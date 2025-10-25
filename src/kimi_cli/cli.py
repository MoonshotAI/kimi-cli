import asyncio
import json
import sys
from pathlib import Path

import click

from kimi_cli import UIMode, __version__, kimi_run
from kimi_cli.agent import DEFAULT_AGENT_FILE
from kimi_cli.config import ConfigError, load_config
from kimi_cli.metadata import continue_session, new_session
from kimi_cli.share import get_share_dir
from kimi_cli.ui.print import InputFormat, OutputFormat
from kimi_cli.ui.shell import Reload
from kimi_cli.utils.logging import logger


@click.command(context_settings=dict(help_option_names=["-h", "--help"]))
@click.version_option(__version__)
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
    default=DEFAULT_AGENT_FILE,
    help="Custom agent specification file. Default: builtin Kimi Koder.",
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
    type=click.Choice(["shell", "print", "acp"]),
    default="shell",
    help="UI mode to use. Default: shell.",
)
@click.option(
    "--print",
    "ui",
    flag_value="print",
    help="Run in print mode. Shortcut for `--ui print`.",
)
@click.option(
    "--acp",
    "ui",
    flag_value="acp",
    help="Start ACP server. Shortcut for `--ui acp`.",
)
@click.option(
    "--input-format",
    type=click.Choice(["text", "stream-json"]),
    default=None,
    help=(
        "Input format to use. Must be used with `--print` "
        "and the input must be piped in via stdin. "
        "Default: text."
    ),
)
@click.option(
    "--output-format",
    type=click.Choice(["text", "stream-json"]),
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
    agent_file: Path,
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
    echo = click.echo if verbose else lambda *args, **kwargs: None

    logger.add(
        get_share_dir() / "logs" / "kimi.log",
        level="DEBUG" if debug else "INFO",
        rotation="06:00",
        retention="10 days",
    )

    work_dir = work_dir.absolute()

    if continue_:
        session = continue_session(work_dir)
        if session is None:
            raise click.BadOptionUsage(
                "--continue", "No previous session found for the working directory"
            )
        echo(f"✓ Continuing previous session: {session.id}")
    else:
        session = new_session(work_dir)
        echo(f"✓ Created new session: {session.id}")
    echo(f"✓ Session history file: {session.history_file}")

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
        mcp_configs = [json.loads(conf.read_text()) for conf in mcp_config_file]
    except json.JSONDecodeError as e:
        raise click.BadOptionUsage("--mcp-config-file", f"Invalid JSON: {e}") from e

    try:
        mcp_configs += [json.loads(conf) for conf in mcp_config]
    except json.JSONDecodeError as e:
        raise click.BadOptionUsage("--mcp-config", f"Invalid JSON: {e}") from e

    while True:
        try:
            try:
                config = load_config()
            except ConfigError as e:
                raise click.ClickException(f"Failed to load config: {e}") from e
            echo(f"✓ Loaded config: {config}")

            succeeded = asyncio.run(
                kimi_run(
                    config=config,
                    model_name=model_name,
                    work_dir=work_dir,
                    session=session,
                    command=command,
                    agent_file=agent_file,
                    ui=ui,
                    input_format=input_format,
                    output_format=output_format,
                    mcp_configs=mcp_configs,
                    yolo=yolo,
                )
            )
            if not succeeded:
                sys.exit(1)
            break
        except Reload:
            continue


def main():
    kimi()


if __name__ == "__main__":
    main()
