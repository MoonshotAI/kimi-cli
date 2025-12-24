from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
from typing import Any

import acp
from kaos.path import KaosPath

from kimi_cli.acp.mcp import acp_mcp_servers_to_mcp_config
from kimi_cli.acp.session import ACPSession
from kimi_cli.acp.tools import replace_tools
from kimi_cli.acp.types import ACPContentBlock, MCPServer
from kimi_cli.app import KimiCLI
from kimi_cli.constant import NAME, VERSION
from kimi_cli.session import Session
from kimi_cli.soul.slash import registry as soul_slash_registry
from kimi_cli.soul.toolset import KimiToolset
from kimi_cli.utils.logging import logger


class ACPServer:
    def __init__(self) -> None:
        self.client_capabilities: acp.schema.ClientCapabilities | None = None
        self.conn: acp.Client | None = None
        self.sessions: dict[str, ACPSession] = {}

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
            auth_methods=[],
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
            thinking=True,
        )
        self.sessions[session.id] = ACPSession(session.id, cli_instance.run, self.conn)

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
        return acp.NewSessionResponse(session_id=session.id)

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
            thinking=True,
        )
        self.sessions[session.id] = ACPSession(session.id, cli_instance.run, self.conn)

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

    async def set_session_mode(
        self, mode_id: str, session_id: str, **kwargs: Any
    ) -> acp.SetSessionModeResponse | None:
        raise NotImplementedError

    async def set_session_model(
        self, model_id: str, session_id: str, **kwargs: Any
    ) -> acp.SetSessionModelResponse | None:
        raise NotImplementedError

    async def authenticate(self, method_id: str, **kwargs: Any) -> acp.AuthenticateResponse | None:
        raise NotImplementedError

    async def prompt(
        self, prompt: list[ACPContentBlock], session_id: str, **kwargs: Any
    ) -> acp.PromptResponse:
        logger.info("Received prompt request for session: {id}", id=session_id)
        if session_id not in self.sessions:
            logger.error("Session not found: {id}", id=session_id)
            raise acp.RequestError.invalid_params({"session_id": "Session not found"})
        session = self.sessions[session_id]
        return await session.prompt(prompt)

    async def cancel(self, session_id: str, **kwargs: Any) -> None:
        logger.info("Received cancel request for session: {id}", id=session_id)
        if session_id not in self.sessions:
            logger.error("Session not found: {id}", id=session_id)
            raise acp.RequestError.invalid_params({"session_id": "Session not found"})
        session = self.sessions[session_id]
        await session.cancel()

    async def ext_method(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    async def ext_notification(self, method: str, params: dict[str, Any]) -> None:
        raise NotImplementedError
