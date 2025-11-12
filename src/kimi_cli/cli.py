from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Any, Literal

import typer

from kimi_cli.constant import VERSION


class Reload(Exception):
    """Reload configuration."""

    pass


cli = typer.Typer(
    add_completion=False,
    context_settings={"help_option_names": ["-h", "--help"]},
    help="Kimi, your next CLI agent.",
)

UIMode = Literal["shell", "print", "acp", "wire"]
InputFormat = Literal["text", "stream-json"]
OutputFormat = Literal["text", "stream-json"]


def _version_callback(value: bool) -> None:
    if value:
        typer.echo(f"kimi, version {VERSION}")
        raise typer.Exit()


@cli.command()
def kimi(
    version: Annotated[
        bool,
        typer.Option(
            "--version",
            "-V",
            help="Show version and exit.",
            callback=_version_callback,
            is_eager=True,
        ),
    ] = False,
    verbose: Annotated[
        bool,
        typer.Option(
            "--verbose",
            help="Print verbose information. Default: no.",
        ),
    ] = False,
    debug: Annotated[
        bool,
        typer.Option(
            "--debug",
            help="Log debug information. Default: no.",
        ),
    ] = False,
    agent_file: Annotated[
        Path | None,
        typer.Option(
            "--agent-file",
            exists=True,
            file_okay=True,
            dir_okay=False,
            readable=True,
            help="Custom agent specification file. Default: builtin default agent.",
        ),
    ] = None,
    model_name: Annotated[
        str | None,
        typer.Option(
            "--model",
            "-m",
            help="LLM model to use. Default: default model set in config file.",
        ),
    ] = None,
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
            help="Working directory for the agent. Default: current directory.",
        ),
    ] = None,
    continue_: Annotated[
        bool,
        typer.Option(
            "--continue",
            "-C",
            help="Continue the previous session for the working directory. Default: no.",
        ),
    ] = False,
    command: Annotated[
        str | None,
        typer.Option(
            "--command",
            "-c",
            "--query",
            "-q",
            help="User query to the agent. Default: prompt interactively.",
        ),
    ] = None,
    print_mode: Annotated[
        bool,
        typer.Option(
            "--print",
            help=(
                "Run in print mode (non-interactive). Note: print mode implicitly adds `--yolo`."
            ),
        ),
    ] = False,
    acp_mode: Annotated[
        bool,
        typer.Option(
            "--acp",
            help="Run as ACP server.",
        ),
    ] = False,
    wire_mode: Annotated[
        bool,
        typer.Option(
            "--wire",
            help="Run as Wire server (experimental).",
        ),
    ] = False,
    input_format: Annotated[
        InputFormat | None,
        typer.Option(
            "--input-format",
            help=(
                "Input format to use. Must be used with `--print` "
                "and the input must be piped in via stdin. "
                "Default: text."
            ),
        ),
    ] = None,
    output_format: Annotated[
        OutputFormat | None,
        typer.Option(
            "--output-format",
            help="Output format to use. Must be used with `--print`. Default: text.",
        ),
    ] = None,
    mcp_config_file: Annotated[
        list[Path] | None,
        typer.Option(
            "--mcp-config-file",
            exists=True,
            file_okay=True,
            dir_okay=False,
            readable=True,
            help=(
                "MCP config file to load. Add this option multiple times to specify multiple MCP "
                "configs. Default: none."
            ),
        ),
    ] = None,
    mcp_config: Annotated[
        list[str] | None,
        typer.Option(
            "--mcp-config",
            help=(
                "MCP config JSON to load. Add this option multiple times to specify multiple MCP "
                "configs. Default: none."
            ),
        ),
    ] = None,
    yolo: Annotated[
        bool,
        typer.Option(
            "--yolo",
            "--yes",
            "-y",
            "--auto-approve",
            help="Automatically approve all actions. Default: no.",
        ),
    ] = False,
    thinking: Annotated[
        bool | None,
        typer.Option(
            "--thinking",
            help="Enable thinking mode if supported. Default: same as last time.",
        ),
    ] = None,
):
    """Kimi, your next CLI agent."""
    del version  # handled in the callback

    from kimi_cli.app import KimiCLI
    from kimi_cli.session import Session
    from kimi_cli.share import get_share_dir
    from kimi_cli.utils.logging import logger

    def _noop_echo(*args: Any, **kwargs: Any):
        pass

    special_flags = {
        "--print": print_mode,
        "--acp": acp_mode,
        "--wire": wire_mode,
    }
    active_specials = [flag for flag, active in special_flags.items() if active]
    if len(active_specials) > 1:
        raise typer.BadParameter(
            f"Cannot combine {', '.join(active_specials)}.",
            param_hint=active_specials[0],
        )

    ui: UIMode = "shell"
    if print_mode:
        ui = "print"
    elif acp_mode:
        ui = "acp"
    elif wire_mode:
        ui = "wire"

    echo: Callable[..., None] = typer.echo if verbose else _noop_echo

    if debug:
        logger.enable("kosong")
    logger.add(
        get_share_dir() / "logs" / "kimi.log",
        # FIXME: configure level for different modules
        level="TRACE" if debug else "INFO",
        rotation="06:00",
        retention="10 days",
    )

    work_dir = (work_dir or Path.cwd()).absolute()
    if continue_:
        session = Session.continue_(work_dir)
        if session is None:
            raise typer.BadParameter(
                "No previous session found for the working directory",
                param_hint="--continue",
            )
        echo(f"✓ Continuing previous session: {session.id}")
    else:
        session = Session.create(work_dir)
        echo(f"✓ Created new session: {session.id}")
    echo(f"✓ Session history file: {session.history_file}")

    if command is not None:
        command = command.strip()
        if not command:
            raise typer.BadParameter("Command cannot be empty", param_hint="--command")

    if input_format is not None and ui != "print":
        raise typer.BadParameter(
            "Input format is only supported for print UI",
            param_hint="--input-format",
        )
    if output_format is not None and ui != "print":
        raise typer.BadParameter(
            "Output format is only supported for print UI",
            param_hint="--output-format",
        )

    file_configs = list(mcp_config_file or [])
    raw_mcp_config = list(mcp_config or [])

    try:
        mcp_configs = [json.loads(conf.read_text(encoding="utf-8")) for conf in file_configs]
    except json.JSONDecodeError as e:
        raise typer.BadParameter(f"Invalid JSON: {e}", param_hint="--mcp-config-file") from e

    try:
        mcp_configs += [json.loads(conf) for conf in raw_mcp_config]
    except json.JSONDecodeError as e:
        raise typer.BadParameter(f"Invalid JSON: {e}", param_hint="--mcp-config") from e

    async def _run() -> bool:
        from kimi_cli.metadata import WorkDirMeta, load_metadata, save_metadata

        if thinking is None:
            metadata = load_metadata()
            thinking_mode = metadata.thinking
        else:
            thinking_mode = thinking

        instance = await KimiCLI.create(
            session,
            yolo=yolo or (ui == "print"),  # print mode implies yolo
            stream=ui != "print",  # use non-streaming mode only for print UI
            mcp_configs=mcp_configs,
            model_name=model_name,
            thinking=thinking_mode,
            agent_file=agent_file,
        )
        match ui:
            case "shell":
                succeeded = await instance.run_shell_mode(command)
            case "print":
                succeeded = await instance.run_print_mode(
                    input_format or "text",
                    output_format or "text",
                    command,
                )
            case "acp":
                if command is not None:
                    logger.warning("ACP server ignores command argument")
                succeeded = await instance.run_acp_server()
            case "wire":
                if command is not None:
                    logger.warning("Wire server ignores command argument")
                succeeded = await instance.run_wire_server()

        if succeeded:
            metadata = load_metadata()

            # Update work_dir metadata with last session
            work_dir_meta = next(
                (wd for wd in metadata.work_dirs if wd.path == str(session.work_dir)), None
            )

            if work_dir_meta is None:
                logger.warning(
                    "Work dir metadata missing when marking last session, recreating: {work_dir}",
                    work_dir=session.work_dir,
                )
                work_dir_meta = WorkDirMeta(path=str(session.work_dir))
                metadata.work_dirs.append(work_dir_meta)

            work_dir_meta.last_session_id = session.id

            # Update thinking mode
            metadata.thinking = instance.soul.thinking

            save_metadata(metadata)

        return succeeded

    while True:
        try:
            succeeded = asyncio.run(_run())
            if succeeded:
                break
            sys.exit(1)
        except Reload:
            continue


if __name__ == "__main__":
    if "kimi_cli.cli" not in sys.modules:
        sys.modules["kimi_cli.cli"] = sys.modules[__name__]

    sys.exit(cli())
