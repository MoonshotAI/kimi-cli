"""OAuth client utilities with workarounds for upstream fastmcp/MCP SDK issues."""

from __future__ import annotations

from typing import Any

from fastmcp.client.auth.oauth import OAuth


def create_oauth(mcp_url: str, scopes: list[str] | None = None) -> OAuth:
    """Create an OAuth client with workarounds for upstream fastmcp/MCP SDK bugs.

    Works around three issues:
    - fastmcp strips the URL path, breaking RFC 8707 resource matching
    - fastmcp's redirect_handler pre-flight GET misinterprets 400 responses
    - MCP SDK rejects HTTP 201 on token exchange (e.g. Supabase)
    """
    import webbrowser

    import httpx

    class _PatchedOAuthClient(OAuth):
        """OAuth client with workarounds for upstream fastmcp/MCP SDK issues.

        FIXME: Remove once upstream fixes land in fastmcp and mcp SDK.
        """

        def __init__(self, url: str, **kwargs: Any) -> None:
            super().__init__(url, **kwargs)
            self.context.server_url = url

        async def redirect_handler(self, authorization_url: str) -> None:
            # Skip pre-flight GET that misinterprets 400 as "client not found"
            webbrowser.open(authorization_url)

        async def _handle_token_response(self, response: httpx.Response) -> None:
            # Accept 201 for token exchange (Supabase returns this)
            if response.status_code == 201:
                response.status_code = 200
            await super()._handle_token_response(response)

    return _PatchedOAuthClient(mcp_url, scopes=scopes)
