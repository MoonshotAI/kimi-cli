from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncGenerator
from typing import Any

import acp
from kosong.message import ContentPart

from kimi_cli.acp.kaos import ACPKaos
from kimi_cli.acp.mcp import acp_mcp_servers_to_mcp_config
from kimi_cli.acp.session import ACPSession
from kimi_cli.acp.tools import replace_tools
from kimi_cli.acp.types import ACPContentBlock, MCPServer
from kimi_cli.constant import NAME, VERSION
from kimi_cli.soul import Soul, run_soul
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.toolset import KimiToolset
from kimi_cli.utils.logging import logger
from kimi_cli.wire import Wire, WireUISide
from kimi_cli.wire.message import WireMessage


class ACPServerSingleSession:
    def __init__(self, soul: Soul):
        self.soul = soul
        self._client_capabilities: acp.schema.ClientCapabilities | None = None
        self._conn: acp.Client | None = None
        self._session: ACPSession | None = None

    def on_connect(self, conn: acp.Client) -> None:
        """Handle new client connection."""
        logger.info("ACP client connected")
        self._conn = conn

    async def initialize(
        self,
        protocol_version: int,
        client_capabilities: acp.schema.ClientCapabilities | None = None,
        client_info: acp.schema.Implementation | None = None,
        **kwargs: Any,
    ) -> acp.InitializeResponse:
        """Handle initialize request."""
        logger.info(
            "ACP server initialized with protocol version: {version}, "
            "client capabilities: {capabilities}, client info: {info}",
            version=protocol_version,
            capabilities=client_capabilities,
            info=client_info,
        )
        self._client_capabilities = client_capabilities
        return acp.InitializeResponse(
            protocol_version=protocol_version,
            agent_capabilities=acp.schema.AgentCapabilities(
                load_session=False,
                prompt_capabilities=acp.schema.PromptCapabilities(
                    embedded_context=False, image=True, audio=False
                ),
                mcp_capabilities=acp.schema.McpCapabilities(http=True, sse=False),
                session_capabilities=acp.schema.SessionCapabilities(),
            ),
            auth_methods=[],
            agent_info=acp.schema.Implementation(name=NAME, version=VERSION),
        )

    async def new_session(
        self, cwd: str, mcp_servers: list[MCPServer], **kwargs: Any
    ) -> acp.NewSessionResponse:
        """Handle new session request."""
        logger.info("Creating new session for working directory: {cwd}", cwd=cwd)
        assert self._conn is not None, "ACP client not connected"
        assert self._client_capabilities is not None, "ACP connection not initialized"

        async def prompt_fn(
            user_input: list[ContentPart], cancel_event: asyncio.Event
        ) -> AsyncGenerator[WireMessage]:
            """Prompt function to run the soul."""
            wire_future = asyncio.Future[WireUISide]()
            stop_ui_loop = asyncio.Event()

            async def _ui_loop_fn(wire: Wire) -> None:
                wire_future.set_result(wire.ui_side(merge=False))
                await stop_ui_loop.wait()

            soul_task = asyncio.create_task(
                run_soul(self.soul, user_input, _ui_loop_fn, cancel_event)
            )

            try:
                wire_ui = await wire_future
                while True:
                    msg = await wire_ui.receive()
                    yield msg
            except asyncio.QueueShutDown:
                pass
            finally:
                # stop consuming Wire messages
                stop_ui_loop.set()
                # wait for the soul task to finish, or raise
                await soul_task

        session_id = (
            self.soul.runtime.session.id if isinstance(self.soul, KimiSoul) else str(uuid.uuid4())
        )
        acp_kaos = ACPKaos(self._conn, session_id, self._client_capabilities)
        self._session = ACPSession(session_id, prompt_fn, self._conn, kaos=acp_kaos)

        mcp_config = acp_mcp_servers_to_mcp_config(mcp_servers)
        if (
            mcp_config
            and isinstance(self.soul, KimiSoul)
            and isinstance(self.soul.agent.toolset, KimiToolset)
        ):
            # Load MCP tools if supported
            await self.soul.agent.toolset.load_mcp_tools([mcp_config], self.soul.runtime)

        if isinstance(self.soul, KimiSoul) and isinstance(self.soul.agent.toolset, KimiToolset):
            replace_tools(
                self._client_capabilities,
                self._conn,
                self._session.id,
                self.soul.agent.toolset,
                self.soul.runtime,
            )

        available_commands = [
            acp.schema.AvailableCommand(name=cmd.name, description=cmd.description)
            for cmd in self.soul.available_slash_commands
        ]
        asyncio.create_task(
            self._conn.session_update(
                session_id=self._session.id,
                update=acp.schema.AvailableCommandsUpdate(
                    session_update="available_commands_update",
                    available_commands=available_commands,
                ),
            )
        )
        return acp.NewSessionResponse(session_id=self._session.id)

    async def load_session(
        self, cwd: str, mcp_servers: list[MCPServer], session_id: str, **kwargs: Any
    ) -> None:
        raise NotImplementedError

    async def list_sessions(
        self, cursor: str | None = None, cwd: str | None = None, **kwargs: Any
    ) -> acp.schema.ListSessionsResponse:
        raise NotImplementedError

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
        """Handle prompt request with streaming support."""
        logger.info("Received prompt request")
        assert self._session is not None, "ACP session not initialized"
        return await self._session.prompt(prompt)

    async def cancel(self, session_id: str, **kwargs: Any) -> None:
        """Handle cancel notification."""
        logger.info("Received cancel request")
        assert self._session is not None, "ACP session not initialized"
        return await self._session.cancel()

    async def ext_method(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    async def ext_notification(self, method: str, params: dict[str, Any]) -> None:
        raise NotImplementedError


class ACP:
    """ACP server using the official acp library."""

    def __init__(self, soul: Soul):
        self.soul = soul

    async def run(self):
        """Run the ACP server."""
        logger.info("Starting ACP server (single session) on stdio")
        await acp.run_agent(ACPServerSingleSession(self.soul))
