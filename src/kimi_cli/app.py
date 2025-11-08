import contextlib
import os
import warnings
from collections.abc import Generator
from pathlib import Path
from typing import Any

from pydantic import SecretStr

from kimi_cli.agentspec import DEFAULT_AGENT_FILE
from kimi_cli.cli import InputFormat, OutputFormat
from kimi_cli.config import LLMModel, LLMProvider, load_config
from kimi_cli.llm import augment_provider_with_env_vars, create_llm
from kimi_cli.session import Session
from kimi_cli.soul.agent import load_agent
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.runtime import Runtime
from kimi_cli.utils.logging import StreamToLogger, logger


class KimiCLI:
    @staticmethod
    async def create(
        session: Session,
        *,
        yolo: bool = False,
        stream: bool = True,  # TODO: remove this when we have a correct print mode impl
        mcp_configs: list[dict[str, Any]] | None = None,
        config_file: Path | None = None,
        model_name: str | None = None,
        agent_file: Path | None = None,
    ) -> "KimiCLI":
        """
        Create a KimiCLI instance.

        Args:
            session (Session): A session created by `Session.create` or `Session.continue_`.
            yolo (bool, optional): Approve all actions without confirmation. Defaults to False.
            stream (bool, optional): Use stream mode when calling LLM API. Defaults to True.
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
            llm = create_llm(provider, model, stream=stream, session_id=session.id)

        runtime = await Runtime.create(config, llm, session, yolo)

        if agent_file is None:
            agent_file = DEFAULT_AGENT_FILE
        agent = await load_agent(agent_file, runtime, mcp_configs=mcp_configs or [])

        context = Context(session.history_file)
        await context.restore()

        soul = KimiSoul(
            agent,
            runtime,
            context=context,
        )
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

    @contextlib.contextmanager
    def _app_env(self) -> Generator[None]:
        original_cwd = Path.cwd()
        os.chdir(self._runtime.session.work_dir)
        try:
            # to ignore possible warnings from dateparser
            warnings.filterwarnings("ignore", category=DeprecationWarning)
            with contextlib.redirect_stderr(StreamToLogger()):
                yield
        finally:
            os.chdir(original_cwd)

    async def run_shell_mode(self, command: str | None = None) -> bool:
        from kimi_cli.ui.shell import ShellApp, WelcomeInfoItem

        welcome_info = [
            WelcomeInfoItem(name="Directory", value=str(self._runtime.session.work_dir)),
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
        with self._app_env():
            app = ShellApp(self._soul, welcome_info=welcome_info)
            return await app.run(command)

    async def run_print_mode(
        self,
        input_format: InputFormat,
        output_format: OutputFormat,
        command: str | None = None,
    ) -> bool:
        from kimi_cli.ui.print import PrintApp

        with self._app_env():
            app = PrintApp(
                self._soul,
                input_format,
                output_format,
                self._runtime.session.history_file,
            )
            return await app.run(command)

    async def run_acp_server(self) -> bool:
        from kimi_cli.ui.acp import ACPServer

        with self._app_env():
            app = ACPServer(self._soul)
            return await app.run()

    async def run_wire_server(self) -> bool:
        from kimi_cli.ui.wire import WireServer

        with self._app_env():
            server = WireServer(self._soul)
            return await server.run()
