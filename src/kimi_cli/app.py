from __future__ import annotations

import contextlib
import warnings
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any

from pydantic import SecretStr

import kaos
from kaos.path import KaosPath
from kimi_cli.agentspec import DEFAULT_AGENT_FILE
from kimi_cli.cli import InputFormat, OutputFormat
from kimi_cli.config import LLMModel, LLMProvider, load_config
from kimi_cli.llm import augment_provider_with_env_vars, create_llm
from kimi_cli.session import Session
from kimi_cli.share import get_share_dir
from kimi_cli.soul import LLMNotSet, LLMNotSupported
from kimi_cli.soul.agent import Runtime, load_agent
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.utils.logging import StreamToLogger, logger
from kimi_cli.utils.path import shorten_home


def enable_logging(debug: bool = False) -> None:
    if debug:
        logger.enable("kosong")
    logger.add(
        get_share_dir() / "logs" / "kimi.log",
        # FIXME: configure level for different modules
        level="TRACE" if debug else "INFO",
        rotation="06:00",
        retention="10 days",
    )


class KimiCLI:
    @staticmethod
    async def create(
        session: Session,
        *,
        yolo: bool = False,
        mcp_configs: list[dict[str, Any]] | None = None,
        config_file: Path | None = None,
        model_name: str | None = None,
        thinking: bool = False,
        agent_file: Path | None = None,
    ) -> KimiCLI:
        """
        Create a KimiCLI instance.

        Args:
            session (Session): A session created by `Session.create` or `Session.continue_`.
            yolo (bool, optional): Approve all actions without confirmation. Defaults to False.
            config_file (Path | None, optional): Path to the configuration file. Defaults to None.
            model_name (str | None, optional): Name of the model to use. Defaults to None.
            agent_file (Path | None, optional): Path to the agent file. Defaults to None.

        Raises:
            FileNotFoundError: When the agent file is not found.
            ConfigError(KimiCLIException): When the configuration is invalid.
            AgentSpecError(KimiCLIException): When the agent specification is invalid.
        """
        config = load_config(config_file)
        logger.info("Loaded config: {config}", config=config)

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
        env_overrides = augment_provider_with_env_vars(provider, model)

        if not provider.base_url or not model.model:
            llm = None
        else:
            logger.info("Using LLM provider: {provider}", provider=provider)
            logger.info("Using LLM model: {model}", model=model)
            llm = create_llm(provider, model, session_id=session.id)

        runtime = await Runtime.create(config, llm, session, yolo)

        if agent_file is None:
            agent_file = DEFAULT_AGENT_FILE
        agent = await load_agent(agent_file, runtime, mcp_configs=mcp_configs or [])

        context = Context(session.context_file)
        await context.restore()

        soul = KimiSoul(agent, context=context)
        try:
            soul.set_thinking(thinking)
        except (LLMNotSet, LLMNotSupported) as e:
            logger.warning("Failed to enable thinking mode: {error}", error=e)
        return KimiCLI(soul, runtime, env_overrides)

    def __init__(
        self,
        _soul: KimiSoul,
        _runtime: Runtime,
        _env_overrides: dict[str, str],
    ) -> None:
        self._soul = _soul
        self._runtime = _runtime
        self._env_overrides = _env_overrides

    @property
    def soul(self) -> KimiSoul:
        """Get the KimiSoul instance."""
        return self._soul

    @property
    def session(self) -> Session:
        """Get the Session instance."""
        return self._runtime.session

    @contextlib.asynccontextmanager
    async def _app_env(self) -> AsyncGenerator[None]:
        original_cwd = KaosPath.cwd()
        await kaos.chdir(self._runtime.session.work_dir)
        try:
            # to ignore possible warnings from dateparser
            warnings.filterwarnings("ignore", category=DeprecationWarning)
            with contextlib.redirect_stderr(StreamToLogger()):
                yield
        finally:
            await kaos.chdir(original_cwd)

    async def run_shell(self, command: str | None = None) -> bool:
        """Run the Kimi CLI instance with shell UI."""
        from kimi_cli.ui.shell import Shell, WelcomeInfoItem

        welcome_info = [
            WelcomeInfoItem(
                name="Directory", value=str(shorten_home(self._runtime.session.work_dir))
            ),
            WelcomeInfoItem(name="Session", value=self._runtime.session.id),
        ]
        if base_url := self._env_overrides.get("KIMI_BASE_URL"):
            welcome_info.append(
                WelcomeInfoItem(
                    name="API URL",
                    value=f"{base_url} (from KIMI_BASE_URL)",
                    level=WelcomeInfoItem.Level.WARN,
                )
            )
        if self._env_overrides.get("KIMI_API_KEY"):
            welcome_info.append(
                WelcomeInfoItem(
                    name="API Key",
                    value="****** (from KIMI_API_KEY)",
                    level=WelcomeInfoItem.Level.WARN,
                )
            )
        if not self._runtime.llm:
            welcome_info.append(
                WelcomeInfoItem(
                    name="Model",
                    value="not set, send /setup to configure",
                    level=WelcomeInfoItem.Level.WARN,
                )
            )
        elif "KIMI_MODEL_NAME" in self._env_overrides:
            welcome_info.append(
                WelcomeInfoItem(
                    name="Model",
                    value=f"{self._soul.model_name} (from KIMI_MODEL_NAME)",
                    level=WelcomeInfoItem.Level.WARN,
                )
            )
        else:
            welcome_info.append(
                WelcomeInfoItem(
                    name="Model",
                    value=self._soul.model_name,
                    level=WelcomeInfoItem.Level.INFO,
                )
            )
        async with self._app_env():
            shell = Shell(self._soul, welcome_info=welcome_info)
            return await shell.run(command)

    async def run_print(
        self,
        input_format: InputFormat,
        output_format: OutputFormat,
        command: str | None = None,
    ) -> bool:
        """Run the Kimi CLI instance with print UI."""
        from kimi_cli.ui.print import Print

        async with self._app_env():
            print_ = Print(
                self._soul,
                input_format,
                output_format,
                self._runtime.session.context_file,
            )
            return await print_.run(command)

    async def run_acp(self) -> None:
        """Run the Kimi CLI instance as ACP server."""
        from kimi_cli.ui.acp import ACP

        async with self._app_env():
            acp = ACP(self._soul)
            await acp.run()

    async def run_wire_stdio(self) -> None:
        """Run the Kimi CLI instance as Wire server over stdio."""
        from kimi_cli.ui.wire import WireOverStdio

        async with self._app_env():
            server = WireOverStdio(self._soul)
            await server.serve()
