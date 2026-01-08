from __future__ import annotations

from typing import Any, NoReturn

import acp

from kimi_cli.acp.types import ACPContentBlock, MCPServer
from kimi_cli.soul import Soul
from kimi_cli.utils.logging import logger

_DEPRECATED_MESSAGE = (
    "`kimi --acp` is deprecated. "
    "Update your ACP client settings to use `kimi acp` without any flags or options."
)


class ACPServerSingleSession:
    def __init__(self, soul: Soul):
        self.soul = soul

    def on_connect(self, conn: acp.Client) -> None:
        logger.info("ACP client connected")

    def _raise(self) -> NoReturn:
        logger.error(_DEPRECATED_MESSAGE)
        raise acp.RequestError.invalid_params({"error": _DEPRECATED_MESSAGE})

    async def initialize(
        self,
        protocol_version: int,
        client_capabilities: acp.schema.ClientCapabilities | None = None,
        client_info: acp.schema.Implementation | None = None,
        **kwargs: Any,
    ) -> acp.InitializeResponse:
        self._raise()

    async def new_session(
        self, cwd: str, mcp_servers: list[MCPServer], **kwargs: Any
    ) -> acp.NewSessionResponse:
        self._raise()

    async def load_session(
        self, cwd: str, mcp_servers: list[MCPServer], session_id: str, **kwargs: Any
    ) -> None:
        self._raise()

    async def list_sessions(
        self, cursor: str | None = None, cwd: str | None = None, **kwargs: Any
    ) -> acp.schema.ListSessionsResponse:
        self._raise()

    async def set_session_mode(
        self, mode_id: str, session_id: str, **kwargs: Any
    ) -> acp.SetSessionModeResponse | None:
        self._raise()

    async def set_session_model(
        self, model_id: str, session_id: str, **kwargs: Any
    ) -> acp.SetSessionModelResponse | None:
        self._raise()

    async def authenticate(self, method_id: str, **kwargs: Any) -> acp.AuthenticateResponse | None:
        self._raise()

    async def prompt(
        self, prompt: list[ACPContentBlock], session_id: str, **kwargs: Any
    ) -> acp.PromptResponse:
        self._raise()

    async def cancel(self, session_id: str, **kwargs: Any) -> None:
        self._raise()

    async def ext_method(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self._raise()

    async def ext_notification(self, method: str, params: dict[str, Any]) -> None:
        self._raise()


class ACP:
    """ACP server using the official acp library."""

    def __init__(self, soul: Soul):
        self.soul = soul

    async def run(self):
        """Run the ACP server."""
        logger.info("Starting ACP server (single session) on stdio")
        await acp.run_agent(ACPServerSingleSession(self.soul))
