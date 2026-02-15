from loguru import logger

# Disable logging by default for library usage.
# Application entry points (e.g., kimi_cli.cli) should call logger.enable("kimi_cli")
# to enable logging.
logger.disable("kimi_cli")


def _patch_streamable_http_transport() -> None:
    """Patch StreamableHttpTransport to not attempt session termination on close.

    This fixes the "Session termination failed: 404" warning from the MCP library
    when connecting to servers like Supabase that don't support session DELETE.
    """
    try:
        import contextlib
        from collections.abc import AsyncIterator
        from typing import Any, Unpack

        from fastmcp.client.transports import SessionKwargs, StreamableHttpTransport
        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        @contextlib.asynccontextmanager
        async def patched_connect_session(
            self: StreamableHttpTransport,
            **session_kwargs: Unpack[SessionKwargs],
        ) -> AsyncIterator[ClientSession]:
            client_kwargs: dict[str, Any] = {}
            # Import get_http_headers here to match the original implementation
            from fastmcp.server.dependencies import get_http_headers

            client_kwargs["headers"] = get_http_headers() | self.headers

            if self.sse_read_timeout is not None:
                client_kwargs["sse_read_timeout"] = self.sse_read_timeout
            if session_kwargs.get("read_timeout_seconds") is not None:
                client_kwargs["timeout"] = session_kwargs.get("read_timeout_seconds")

            # Add terminate_on_close=False to prevent 404 errors on session cleanup
            client_kwargs["terminate_on_close"] = False

            async with streamablehttp_client(
                self.url,
                auth=self.auth,
                **client_kwargs,
            ) as transport:
                read_stream, write_stream, _ = transport
                async with ClientSession(
                    read_stream, write_stream, **session_kwargs
                ) as session:
                    yield session

        # Apply the patch
        StreamableHttpTransport.connect_session = patched_connect_session
    except Exception:
        # If patching fails (e.g., due to version changes), silently continue
        pass


# Apply the patch early on import
_patch_streamable_http_transport()

# Clean up the namespace
del _patch_streamable_http_transport
