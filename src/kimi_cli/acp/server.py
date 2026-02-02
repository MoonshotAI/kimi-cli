from __future__ import annotations

import asyncio
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, NamedTuple

import acp
from kaos.path import KaosPath

from kimi_cli.acp.kaos import ACPKaos
from kimi_cli.acp.mcp import acp_mcp_servers_to_mcp_config
from kimi_cli.acp.session import ACPSession
from kimi_cli.acp.tools import replace_tools
from kimi_cli.acp.types import ACPContentBlock, MCPServer
from kimi_cli.app import KimiCLI
from kimi_cli.config import LLMModel, load_config, save_config
from kimi_cli.constant import NAME, VERSION
from kimi_cli.llm import create_llm, derive_model_capabilities
from kimi_cli.session import Session
from kimi_cli.soul.slash import registry as soul_slash_registry
from kimi_cli.soul.toolset import KimiToolset
from kimi_cli.utils.logging import logger


class ACPServer:
    def __init__(self) -> None:
        self.client_capabilities: acp.schema.ClientCapabilities | None = None
        self.conn: acp.Client | None = None
        self.sessions: dict[str, tuple[ACPSession, _ModelIDConv]] = {}

    def on_connect(self, conn: acp.Client) -> None:
        logger.info("ACP client connected")
        self.conn = conn

    async def initialize(
        self,
        protocol_version: int,
        client_capabilities: acp.schema.ClientCapabilities | None = None,
        client_info: acp.schema.Implementation | None = None,
        **kwargs: Any,
    ) -> acp.InitializeResponse:
        logger.info(
            "ACP server initialized with protocol version: {version}, "
            "client capabilities: {capabilities}, client info: {info}",
            version=protocol_version,
            capabilities=client_capabilities,
            info=client_info,
        )
        self.client_capabilities = client_capabilities

        # get command and args of current process for terminal-auth
        command = sys.argv[0]
        if command.endswith("kimi"):
            args = []
        else:
            idx = sys.argv.index("kimi")
            args = sys.argv[1 : idx + 1]

        return acp.InitializeResponse(
            protocol_version=protocol_version,
            agent_capabilities=acp.schema.AgentCapabilities(
                load_session=True,
                prompt_capabilities=acp.schema.PromptCapabilities(
                    embedded_context=False, image=True, audio=False
                ),
                mcp_capabilities=acp.schema.McpCapabilities(http=True, sse=False),
                session_capabilities=acp.schema.SessionCapabilities(
                    list=acp.schema.SessionListCapabilities(),
                ),
            ),
            auth_methods=[
                acp.schema.AuthMethod(
                    id="login",
                    name="Login with Kimi account",
                    description=(
                        "Run `kimi login` command in the terminal, "
                        "then follow the instructions to finish login."
                    ),
                    field_meta={
                        "terminal-auth": {
                            "command": command,
                            "args": args + ["login"],
                            "label": "Kimi Code Login",
                        }
                    },
                ),
                # acp.schema.AuthMethod(
                #     id="setup",
                #     name="Setup LLM with /setup slash command",
                #     description=(
                #         "Run `kimi` command in the terminal, "
                #         "then send `/setup` command to complete the setup."
                #     ),
                #     field_meta={
                #         "terminal-auth": {
                #             "command": command,
                #             "args": args,
                #             "label": "Kimi Code CLI Setup",
                #         }
                #     },
                # ),
            ],
            agent_info=acp.schema.Implementation(name=NAME, version=VERSION),
        )

    async def new_session(
        self, cwd: str, mcp_servers: list[MCPServer], **kwargs: Any
    ) -> acp.NewSessionResponse:
        logger.info("Creating new session for working directory: {cwd}", cwd=cwd)
        assert self.conn is not None, "ACP client not connected"
        assert self.client_capabilities is not None, "ACP connection not initialized"

        session = await Session.create(KaosPath.unsafe_from_local_path(Path(cwd)))

        mcp_config = acp_mcp_servers_to_mcp_config(mcp_servers)
        cli_instance = await KimiCLI.create(
            session,
            mcp_configs=[mcp_config],
        )
        config = cli_instance.soul.runtime.config
        acp_kaos = ACPKaos(self.conn, session.id, self.client_capabilities)
        acp_session = ACPSession(session.id, cli_instance, self.conn, kaos=acp_kaos)
        model_id_conv = _ModelIDConv(config.default_model, config.default_thinking)
        self.sessions[session.id] = (acp_session, model_id_conv)

        if isinstance(cli_instance.soul.agent.toolset, KimiToolset):
            replace_tools(
                self.client_capabilities,
                self.conn,
                session.id,
                cli_instance.soul.agent.toolset,
                cli_instance.soul.runtime,
            )

        available_commands = [
            acp.schema.AvailableCommand(name=cmd.name, description=cmd.description)
            for cmd in soul_slash_registry.list_commands()
        ]
        asyncio.create_task(
            self.conn.session_update(
                session_id=session.id,
                update=acp.schema.AvailableCommandsUpdate(
                    session_update="available_commands_update",
                    available_commands=available_commands,
                ),
            )
        )
        return acp.NewSessionResponse(
            session_id=session.id,
            modes=acp.schema.SessionModeState(
                available_modes=[
                    acp.schema.SessionMode(
                        id="default",
                        name="Default",
                        description="The default mode.",
                    ),
                ],
                current_mode_id="default",
            ),
            models=acp.schema.SessionModelState(
                available_models=_expand_llm_models(config.models),
                current_model_id=model_id_conv.to_acp_model_id(),
            ),
        )

    async def load_session(
        self, cwd: str, mcp_servers: list[MCPServer], session_id: str, **kwargs: Any
    ) -> None:
        logger.info("Loading session: {id} for working directory: {cwd}", id=session_id, cwd=cwd)
        assert self.conn is not None, "ACP client not connected"
        assert self.client_capabilities is not None, "ACP connection not initialized"

        if session_id in self.sessions:
            logger.warning("Session already loaded: {id}", id=session_id)
            return

        work_dir = KaosPath.unsafe_from_local_path(Path(cwd))
        session = await Session.find(work_dir, session_id)
        if session is None:
            logger.error(
                "Session not found: {id} for working directory: {cwd}", id=session_id, cwd=cwd
            )
            raise acp.RequestError.invalid_params({"session_id": "Session not found"})

        mcp_config = acp_mcp_servers_to_mcp_config(mcp_servers)
        cli_instance = await KimiCLI.create(
            session,
            mcp_configs=[mcp_config],
        )
        config = cli_instance.soul.runtime.config
        acp_kaos = ACPKaos(self.conn, session.id, self.client_capabilities)
        acp_session = ACPSession(session.id, cli_instance, self.conn, kaos=acp_kaos)
        model_id_conv = _ModelIDConv(config.default_model, config.default_thinking)
        self.sessions[session.id] = (acp_session, model_id_conv)

        if isinstance(cli_instance.soul.agent.toolset, KimiToolset):
            replace_tools(
                self.client_capabilities,
                self.conn,
                session.id,
                cli_instance.soul.agent.toolset,
                cli_instance.soul.runtime,
            )

        # TODO: replay session history?

    async def list_sessions(
        self, cursor: str | None = None, cwd: str | None = None, **kwargs: Any
    ) -> acp.schema.ListSessionsResponse:
        logger.info("Listing sessions for working directory: {cwd}", cwd=cwd)
        if cwd is None:
            return acp.schema.ListSessionsResponse(sessions=[], next_cursor=None)
        work_dir = KaosPath.unsafe_from_local_path(Path(cwd))
        sessions = await Session.list(work_dir)
        return acp.schema.ListSessionsResponse(
            sessions=[
                acp.schema.SessionInfo(
                    cwd=cwd,
                    session_id=s.id,
                    title=s.title,
                    updated_at=datetime.fromtimestamp(s.updated_at).astimezone().isoformat(),
                )
                for s in sessions
            ],
            next_cursor=None,
        )

    async def set_session_mode(self, mode_id: str, session_id: str, **kwargs: Any) -> None:
        assert mode_id == "default", "Only default mode is supported"

    async def set_session_model(self, model_id: str, session_id: str, **kwargs: Any) -> None:
        logger.info(
            "Setting session model to {model_id} for session: {id}",
            model_id=model_id,
            id=session_id,
        )
        if session_id not in self.sessions:
            logger.error("Session not found: {id}", id=session_id)
            raise acp.RequestError.invalid_params({"session_id": "Session not found"})

        acp_session, current_model_id = self.sessions[session_id]
        cli_instance = acp_session.cli
        model_id_conv = _ModelIDConv.from_acp_model_id(model_id)
        if model_id_conv == current_model_id:
            return

        config = cli_instance.soul.runtime.config
        new_model = config.models.get(model_id_conv.model_key)
        if new_model is None:
            logger.error("Model not found: {model_key}", model_key=model_id_conv.model_key)
            raise acp.RequestError.invalid_params({"model_id": "Model not found"})
        new_provider = config.providers.get(new_model.provider)
        if new_provider is None:
            logger.error(
                "Provider not found: {provider} for model: {model_key}",
                provider=new_model.provider,
                model_key=model_id_conv.model_key,
            )
            raise acp.RequestError.invalid_params({"model_id": "Model's provider not found"})

        new_llm = create_llm(
            new_provider,
            new_model,
            session_id=acp_session.id,
            thinking=model_id_conv.thinking,
            oauth=cli_instance.soul.runtime.oauth,
        )
        cli_instance.soul.runtime.llm = new_llm

        config.default_model = model_id_conv.model_key
        config.default_thinking = model_id_conv.thinking
        assert config.is_from_default_location, "`kimi acp` must use the default config location"
        config_for_save = load_config()
        config_for_save.default_model = model_id_conv.model_key
        config_for_save.default_thinking = model_id_conv.thinking
        save_config(config_for_save)

    async def authenticate(self, method_id: str, **kwargs: Any) -> acp.AuthenticateResponse | None:
        raise NotImplementedError

    async def prompt(
        self, prompt: list[ACPContentBlock], session_id: str, **kwargs: Any
    ) -> acp.PromptResponse:
        logger.info("Received prompt request for session: {id}", id=session_id)
        if session_id not in self.sessions:
            logger.error("Session not found: {id}", id=session_id)
            raise acp.RequestError.invalid_params({"session_id": "Session not found"})
        acp_session, *_ = self.sessions[session_id]
        return await acp_session.prompt(prompt)

    async def cancel(self, session_id: str, **kwargs: Any) -> None:
        logger.info("Received cancel request for session: {id}", id=session_id)
        if session_id not in self.sessions:
            logger.error("Session not found: {id}", id=session_id)
            raise acp.RequestError.invalid_params({"session_id": "Session not found"})
        acp_session, *_ = self.sessions[session_id]
        await acp_session.cancel()

    async def ext_method(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    async def ext_notification(self, method: str, params: dict[str, Any]) -> None:
        raise NotImplementedError


class _ModelIDConv(NamedTuple):
    model_key: str
    thinking: bool

    @classmethod
    def from_acp_model_id(cls, model_id: str) -> _ModelIDConv:
        if model_id.endswith(",thinking"):
            return _ModelIDConv(model_id[: -len(",thinking")], True)
        return _ModelIDConv(model_id, False)

    def to_acp_model_id(self) -> str:
        if self.thinking:
            return f"{self.model_key},thinking"
        return self.model_key


def _expand_llm_models(models: dict[str, LLMModel]) -> list[acp.schema.ModelInfo]:
    expanded_models: list[acp.schema.ModelInfo] = []
    for model_key, model in models.items():
        capabilities = derive_model_capabilities(model)
        if "thinking" in model.model or "reason" in model.model:
            # always-thinking models
            expanded_models.append(
                acp.schema.ModelInfo(
                    model_id=_ModelIDConv(model_key, True).to_acp_model_id(),
                    name=f"{model.model}",
                )
            )
        else:
            expanded_models.append(
                acp.schema.ModelInfo(
                    model_id=model_key,
                    name=model.model,
                )
            )
            if "thinking" in capabilities:
                # add thinking variant
                expanded_models.append(
                    acp.schema.ModelInfo(
                        model_id=_ModelIDConv(model_key, True).to_acp_model_id(),
                        name=f"{model.model} (thinking)",
                    )
                )
    return expanded_models
