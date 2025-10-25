import asyncio
import contextlib
import importlib.metadata
import json
import os
import subprocess
import sys
import textwrap
import warnings
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

import click
from pydantic import SecretStr

from kimi_cli.agent import (
    DEFAULT_AGENT_FILE,
    AgentGlobals,
    BuiltinSystemPromptArgs,
    load_agent_with_mcp,
    load_agents_md,
)
from kimi_cli.config import (
    Config,
    ConfigError,
    LLMModel,
    LLMProvider,
    load_config,
)
from kimi_cli.metadata import Session, continue_session, new_session
from kimi_cli.share import get_share_dir
from kimi_cli.soul.approval import Approval
from kimi_cli.soul.context import Context
from kimi_cli.soul.denwarenji import DenwaRenji
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.acp import ACPServer
from kimi_cli.ui.print import InputFormat, OutputFormat, PrintApp
from kimi_cli.ui.shell import Reload, ShellApp
from kimi_cli.utils.logging import StreamToLogger, logger
from kimi_cli.utils.provider import augment_provider_with_env_vars, create_llm

__version__ = importlib.metadata.version("kimi-cli")
USER_AGENT = f"KimiCLI/{__version__}"

UIMode = Literal["shell", "print", "acp"]


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
                    verbose=verbose,
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


async def kimi_run(
    *,
    config: Config,
    model_name: str | None,
    work_dir: Path,
    session: Session,
    command: str | None = None,
    agent_file: Path = DEFAULT_AGENT_FILE,
    verbose: bool = True,
    ui: UIMode = "shell",
    input_format: InputFormat | None = None,
    output_format: OutputFormat | None = None,
    mcp_configs: list[dict[str, Any]] | None = None,
    yolo: bool = False,
) -> bool:
    """Run Kimi CLI."""
    echo = click.echo if verbose else lambda *args, **kwargs: None

    model: LLMModel | None = None
    provider: LLMProvider | None = None

    # try to use config file
    if not model_name and config.default_model:
        # no --model specified && default model is set in config
        model = config.models[config.default_model]
        provider = config.providers[model.provider]
    if model_name and model_name in config.models:
        # --model specified && model is set in config
        model = config.models[model_name]
        provider = config.providers[model.provider]

    if not model:
        model = LLMModel(provider="", model="", max_context_size=100_000)
        provider = LLMProvider(type="kimi", base_url="", api_key=SecretStr(""))

    # try overwrite with environment variables
    assert provider is not None
    assert model is not None
    augment_provider_with_env_vars(provider, model)

    if not provider.base_url or not model.model:
        llm = None
    else:
        echo(f"✓ Using LLM provider: {provider}")
        echo(f"✓ Using LLM model: {model}")
        stream = ui != "print"  # use non-streaming mode only for print UI
        llm = create_llm(provider, model, stream=stream, session_id=session.id)

    # Get directory listing
    if sys.platform == "win32":
        ls = subprocess.run(
            ["cmd", "/c", "dir"], capture_output=True, text=True, encoding="utf-8", errors="replace"
        )
    else:
        ls = subprocess.run(["ls", "-la"], capture_output=True, text=True)
    agents_md = load_agents_md(work_dir) or ""
    if agents_md:
        echo(f"✓ Loaded agents.md: {textwrap.shorten(agents_md, width=100)}")

    agent_globals = AgentGlobals(
        config=config,
        llm=llm,
        builtin_args=BuiltinSystemPromptArgs(
            KIMI_NOW=datetime.now().astimezone().isoformat(),
            KIMI_WORK_DIR=work_dir,
            KIMI_WORK_DIR_LS=ls.stdout,
            KIMI_AGENTS_MD=agents_md,
        ),
        denwa_renji=DenwaRenji(),
        session=session,
        approval=Approval(yolo=yolo),
    )
    try:
        agent = await load_agent_with_mcp(agent_file, agent_globals, mcp_configs or [])
    except ValueError as e:
        raise click.BadParameter(f"Failed to load agent: {e}") from e
    echo(f"✓ Loaded agent: {agent.name}")
    echo(f"✓ Loaded system prompt: {textwrap.shorten(agent.system_prompt, width=100)}")
    echo(f"✓ Loaded tools: {[tool.name for tool in agent.toolset.tools]}")

    if command is not None:
        command = command.strip()
        if not command:
            raise click.BadParameter("Command cannot be empty")

    context = Context(session.history_file)
    restored = await context.restore()
    if restored:
        echo(f"✓ Restored history from {session.history_file}")

    soul = KimiSoul(
        agent,
        agent_globals,
        context=context,
        loop_control=config.loop_control,
    )

    original_cwd = Path.cwd()
    os.chdir(work_dir)

    try:
        if ui == "shell":
            if command is None and not sys.stdin.isatty():
                command = sys.stdin.read().strip()
                echo(f"✓ Read command from stdin: {command}")

            app = ShellApp(
                soul,
                welcome_info={
                    "Directory": str(work_dir),
                    "Session": session.id,
                },
            )
            # to ignore possible warnings from dateparser
            warnings.filterwarnings("ignore", category=DeprecationWarning)
            with contextlib.redirect_stderr(StreamToLogger()):
                return await app.run(command)
        elif ui == "print":
            app = PrintApp(soul, input_format or "text", output_format or "text")
            return await app.run(command)
        elif ui == "acp":
            if command is not None:
                logger.warning("ACP server ignores command argument")
            app = ACPServer(soul)
            return await app.run()
        else:
            raise click.BadParameter(f"Invalid UI mode: {ui}")
    finally:
        os.chdir(original_cwd)


def main():
    kimi()


if __name__ == "__main__":
    main()
