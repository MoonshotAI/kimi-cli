import contextlib
import os
import warnings
from pathlib import Path
from typing import Any, Literal

import click
from pydantic import SecretStr

from kimi_cli.agentspec import DEFAULT_AGENT_FILE
from kimi_cli.config import Config, LLMModel, LLMProvider
from kimi_cli.llm import augment_provider_with_env_vars, create_llm
from kimi_cli.metadata import Session
from kimi_cli.soul.agent import load_agent_with_mcp
from kimi_cli.soul.context import Context
from kimi_cli.soul.globals import AgentGlobals
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.acp import ACPServer
from kimi_cli.ui.print import InputFormat, OutputFormat, PrintApp
from kimi_cli.ui.shell import ShellApp
from kimi_cli.utils.logging import StreamToLogger, logger

UIMode = Literal["shell", "print", "acp"]


async def kimi_run(
    *,
    config: Config,
    model_name: str | None,
    work_dir: Path,
    session: Session,
    command: str | None = None,
    agent_file: Path = DEFAULT_AGENT_FILE,
    ui: UIMode = "shell",
    input_format: InputFormat | None = None,
    output_format: OutputFormat | None = None,
    mcp_configs: list[dict[str, Any]] | None = None,
    yolo: bool = False,
) -> bool:
    """Run Kimi CLI."""
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
        logger.info("Using LLM provider: {provider}", provider=provider)
        logger.info("Using LLM model: {model}", model=model)
        stream = ui != "print"  # use non-streaming mode only for print UI
        llm = create_llm(provider, model, stream=stream, session_id=session.id)

    agent_globals = await AgentGlobals.create(config, llm, session, yolo)
    try:
        agent = await load_agent_with_mcp(agent_file, agent_globals, mcp_configs or [])
    except ValueError as e:
        raise click.BadParameter(f"Failed to load agent: {e}") from e

    if command is not None:
        command = command.strip()
        if not command:
            raise click.BadParameter("Command cannot be empty")

    context = Context(session.history_file)
    await context.restore()

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
            soul._approval.set_yolo(True)  # print mode implies yolo mode
            app = PrintApp(
                soul,
                input_format or "text",
                output_format or "text",
                context.file_backend,
            )
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
