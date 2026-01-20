from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Annotated, Literal

import typer

from kimi_cli.constant import VERSION

from .info import cli as info_cli
from .mcp import cli as mcp_cli


class Reload(Exception):
    """Reload configuration."""

    def __init__(self, session_id: str | None = None):
        super().__init__("reload")
        self.session_id = session_id


cli = typer.Typer(
    epilog="""\b\
Documentation:        https://moonshotai.github.io/kimi-cli/\n
LLM friendly version: https://moonshotai.github.io/kimi-cli/llms.txt""",
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


@cli.callback(invoke_without_command=True)
def kimi(
    ctx: typer.Context,
    # Meta
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
    # Basic configuration
    local_work_dir: Annotated[
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
    session_id: Annotated[
        str | None,
        typer.Option(
            "--session",
            "-S",
            help="Session ID to resume for the working directory. Default: new session.",
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
    config_string: Annotated[
        str | None,
        typer.Option(
            "--config",
            help="Config TOML/JSON string to load. Default: none.",
        ),
    ] = None,
    config_file: Annotated[
        Path | None,
        typer.Option(
            "--config-file",
            exists=True,
            file_okay=True,
            dir_okay=False,
            readable=True,
            help="Config TOML/JSON file to load. Default: ~/.kimi/config.toml.",
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
    thinking: Annotated[
        bool | None,
        typer.Option(
            "--thinking/--no-thinking",
            help="Enable thinking mode. Default: default thinking mode set in config file.",
        ),
    ] = None,
    # Run mode
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
    prompt: Annotated[
        str | None,
        typer.Option(
            "--prompt",
            "-p",
            "--command",
            "-c",
            help="User prompt to the agent. Default: prompt interactively.",
        ),
    ] = None,
    prompt_flow: Annotated[
        Path | None,
        typer.Option(
            "--prompt-flow",
            exists=True,
            file_okay=True,
            dir_okay=False,
            readable=True,
            help="D2 (.d2) or Mermaid (.mmd) flowchart file to run as a prompt flow.",
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
            help="(Deprecated, use `kimi acp` instead) Run as ACP server.",
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
    final_message_only: Annotated[
        bool,
        typer.Option(
            "--final-message-only",
            help="Only print the final assistant message (print UI).",
        ),
    ] = False,
    quiet: Annotated[
        bool,
        typer.Option(
            "--quiet",
            help="Alias for `--print --output-format text --final-message-only`.",
        ),
    ] = False,
    # Customization
    agent: Annotated[
        Literal["default", "okabe"] | None,
        typer.Option(
            "--agent",
            help="Builtin agent specification to use. Default: builtin default agent.",
        ),
    ] = None,
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
    local_skills_dir: Annotated[
        Path | None,
        typer.Option(
            "--skills-dir",
            exists=True,
            file_okay=False,
            dir_okay=True,
            readable=True,
            help="Path to the skills directory. Overrides discovery.",
        ),
    ] = None,
    # Loop control
    max_steps_per_turn: Annotated[
        int | None,
        typer.Option(
            "--max-steps-per-turn",
            min=1,
            help="Maximum number of steps in one turn. Default: from config.",
        ),
    ] = None,
    max_retries_per_step: Annotated[
        int | None,
        typer.Option(
            "--max-retries-per-step",
            min=1,
            help="Maximum number of retries in one step. Default: from config.",
        ),
    ] = None,
    max_ralph_iterations: Annotated[
        int | None,
        typer.Option(
            "--max-ralph-iterations",
            min=-1,
            help=(
                "Extra iterations after the first turn in Ralph mode. Use -1 for unlimited. "
                "Default: from config."
            ),
        ),
    ] = None,
):
    """Kimi, your next CLI agent."""
    if ctx.invoked_subcommand is not None:
        return  # skip rest if a subcommand is invoked

    del version  # handled in the callback

    from kaos.path import KaosPath

    from kimi_cli.agentspec import DEFAULT_AGENT_FILE, OKABE_AGENT_FILE
    from kimi_cli.app import KimiCLI, enable_logging
    from kimi_cli.config import Config, load_config_from_string
    from kimi_cli.exception import ConfigError
    from kimi_cli.metadata import load_metadata, save_metadata
    from kimi_cli.session import Session
    from kimi_cli.utils.logging import logger

    from .mcp import get_global_mcp_config_file

    enable_logging(debug)

    if session_id is not None:
        session_id = session_id.strip()
        if not session_id:
            raise typer.BadParameter("Session ID cannot be empty", param_hint="--session")

    if quiet:
        if acp_mode or wire_mode:
            raise typer.BadParameter(
                "Quiet mode cannot be combined with ACP or Wire UI",
                param_hint="--quiet",
            )
        if output_format not in (None, "text"):
            raise typer.BadParameter(
                "Quiet mode implies `--output-format text`",
                param_hint="--quiet",
            )
        print_mode = True
        output_format = "text"
        final_message_only = True

    conflict_option_sets = [
        {
            "--print": print_mode,
            "--acp": acp_mode,
            "--wire": wire_mode,
        },
        {
            "--agent": agent is not None,
            "--agent-file": agent_file is not None,
        },
        {
            "--continue": continue_,
            "--session": session_id is not None,
        },
        {
            "--config": config_string is not None,
            "--config-file": config_file is not None,
        },
    ]
    for option_set in conflict_option_sets:
        active_options = [flag for flag, active in option_set.items() if active]
        if len(active_options) > 1:
            raise typer.BadParameter(
                f"Cannot combine {', '.join(active_options)}.",
                param_hint=active_options[0],
            )

    if agent is not None:
        match agent:
            case "default":
                agent_file = DEFAULT_AGENT_FILE
            case "okabe":
                agent_file = OKABE_AGENT_FILE

    ui: UIMode = "shell"
    if print_mode:
        ui = "print"
    elif acp_mode:
        ui = "acp"
    elif wire_mode:
        ui = "wire"

    if prompt is not None:
        prompt = prompt.strip()
        if not prompt:
            raise typer.BadParameter("Prompt cannot be empty", param_hint="--prompt")

    flow = None
    if prompt_flow is not None:
        from kimi_cli.flow import PromptFlowError
        from kimi_cli.flow.d2 import parse_d2_flowchart
        from kimi_cli.flow.mermaid import parse_mermaid_flowchart

        if max_ralph_iterations is not None and max_ralph_iterations != 0:
            raise typer.BadParameter(
                "Prompt flow cannot be used with Ralph mode",
                param_hint="--prompt-flow",
            )
        try:
            flow_text = prompt_flow.read_text(encoding="utf-8")
        except OSError as e:
            raise typer.BadParameter(
                f"Failed to read prompt flow file: {e}", param_hint="--prompt-flow"
            ) from e
        suffix = prompt_flow.suffix.lower()
        if suffix in {".mmd", ".mermaid"}:
            parser = parse_mermaid_flowchart
        elif suffix == ".d2":
            parser = parse_d2_flowchart
        else:
            raise typer.BadParameter(
                "Unsupported prompt flow extension; use .mmd or .d2",
                param_hint="--prompt-flow",
            )
        try:
            flow = parser(flow_text)
        except PromptFlowError as e:
            raise typer.BadParameter(str(e), param_hint="--prompt-flow") from e

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
    if final_message_only and ui != "print":
        raise typer.BadParameter(
            "Final-message-only output is only supported for print UI",
            param_hint="--final-message-only",
        )

    config: Config | Path | None = None
    if config_string is not None:
        config_string = config_string.strip()
        if not config_string:
            raise typer.BadParameter("Config cannot be empty", param_hint="--config")
        try:
            config = load_config_from_string(config_string)
        except ConfigError as e:
            raise typer.BadParameter(str(e), param_hint="--config") from e
    elif config_file is not None:
        config = config_file

    file_configs = list(mcp_config_file or [])
    raw_mcp_config = list(mcp_config or [])

    # Use default MCP config file if no MCP config is provided
    if not file_configs:
        default_mcp_file = get_global_mcp_config_file()
        if default_mcp_file.exists():
            file_configs.append(default_mcp_file)

    try:
        mcp_configs = [json.loads(conf.read_text(encoding="utf-8")) for conf in file_configs]
    except json.JSONDecodeError as e:
        raise typer.BadParameter(f"Invalid JSON: {e}", param_hint="--mcp-config-file") from e

    try:
        mcp_configs += [json.loads(conf) for conf in raw_mcp_config]
    except json.JSONDecodeError as e:
        raise typer.BadParameter(f"Invalid JSON: {e}", param_hint="--mcp-config") from e

    skills_dir: KaosPath | None = None
    if local_skills_dir is not None:
        skills_dir = KaosPath.unsafe_from_local_path(local_skills_dir)

    work_dir = KaosPath.unsafe_from_local_path(local_work_dir) if local_work_dir else KaosPath.cwd()

    async def _run(session_id: str | None) -> bool:
        if session_id is not None:
            session = await Session.find(work_dir, session_id)
            if session is None:
                logger.info(
                    "Session {session_id} not found, creating new session", session_id=session_id
                )
                session = await Session.create(work_dir, session_id)
            logger.info("Switching to session: {session_id}", session_id=session.id)
        elif continue_:
            session = await Session.continue_(work_dir)
            if session is None:
                raise typer.BadParameter(
                    "No previous session found for the working directory",
                    param_hint="--continue",
                )
            logger.info("Continuing previous session: {session_id}", session_id=session.id)
        else:
            session = await Session.create(work_dir)
            logger.info("Created new session: {session_id}", session_id=session.id)

        instance = await KimiCLI.create(
            session,
            config=config,
            model_name=model_name,
            thinking=thinking,
            yolo=yolo or (ui == "print"),  # print mode implies yolo
            agent_file=agent_file,
            mcp_configs=mcp_configs,
            skills_dir=skills_dir,
            max_steps_per_turn=max_steps_per_turn,
            max_retries_per_step=max_retries_per_step,
            max_ralph_iterations=max_ralph_iterations,
            flow=flow,
        )
        match ui:
            case "shell":
                succeeded = await instance.run_shell(prompt)
            case "print":
                succeeded = await instance.run_print(
                    input_format or "text",
                    output_format or "text",
                    prompt,
                    final_only=final_message_only,
                )
            case "acp":
                if prompt is not None:
                    logger.warning("ACP server ignores prompt argument")
                await instance.run_acp()
                succeeded = True
            case "wire":
                if prompt is not None:
                    logger.warning("Wire server ignores prompt argument")
                await instance.run_wire_stdio()
                succeeded = True

        if succeeded:
            metadata = load_metadata()

            # Update work_dir metadata with last session
            work_dir_meta = metadata.get_work_dir_meta(session.work_dir)

            if work_dir_meta is None:
                logger.warning(
                    "Work dir metadata missing when marking last session, recreating: {work_dir}",
                    work_dir=session.work_dir,
                )
                work_dir_meta = metadata.new_work_dir_meta(session.work_dir)

            if session.is_empty():
                logger.info(
                    "Session {session_id} has empty context, removing it",
                    session_id=session.id,
                )
                await session.delete()
                if work_dir_meta.last_session_id == session.id:
                    work_dir_meta.last_session_id = None
            else:
                work_dir_meta.last_session_id = session.id

            save_metadata(metadata)

        return succeeded

    while True:
        try:
            succeeded = asyncio.run(_run(session_id))
            session_id = None
            if not succeeded:
                raise typer.Exit(code=1)
            break
        except Reload as e:
            session_id = e.session_id
            continue


cli.add_typer(info_cli, name="info")


@cli.command(context_settings={"allow_extra_args": True, "ignore_unknown_options": True})
def term(
    ctx: typer.Context,
) -> None:
    """Run Toad TUI backed by Kimi CLI ACP server."""
    from .toad import run_term

    run_term(ctx)


@cli.command()
def acp():
    """Run Kimi CLI ACP server."""
    from kimi_cli.acp import acp_main

    acp_main()


cli.add_typer(mcp_cli, name="mcp")


if __name__ == "__main__":
    if "kimi_cli.cli" not in sys.modules:
        sys.modules["kimi_cli.cli"] = sys.modules[__name__]

    sys.exit(cli())
