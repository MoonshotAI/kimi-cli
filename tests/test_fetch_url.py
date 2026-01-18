# ruff: noqa

"""Tests for WebFetch tool."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Protocol

import pytest
import pytest_asyncio
from aiohttp import web
from inline_snapshot import snapshot
from kosong.tooling import ToolReturnValue

from kimi_cli.tools.web.fetch import FetchURL, Params


class MockServerFactory(Protocol):
    async def __call__(
        self,
        response_body: str,
        *,
        content_type: str = "text/html",
        status: int = 200,
    ) -> str: ...


@pytest_asyncio.fixture
async def mock_http_server() -> AsyncIterator[MockServerFactory]:
    """Provide a temporary HTTP server factory that returns static content."""

    runners: list[web.AppRunner] = []

    async def start_server(
        response_body: str,
        *,
        content_type: str = "text/html",
        status: int = 200,
    ) -> str:
        async def handler(request: web.Request) -> web.Response:  # noqa: ARG001
            ct_part, sep, charset_part = content_type.partition(";")
            charset_value: str | None = None
            if sep:
                _, _, charset_value = charset_part.partition("=")
                charset_value = charset_value.strip() or None

            content_type_value = ct_part.strip() or None
            return web.Response(
                text=response_body,
                status=status,
                content_type=content_type_value,
                charset=charset_value,
            )

        app = web.Application()
        app.router.add_get("/", handler)

        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, host="127.0.0.1", port=0)
        await site.start()

        sockets = site._server.sockets  # type: ignore[attr-defined]
        assert sockets, "Server failed to bind to a port."
        port = sockets[0].getsockname()[1]

        runners.append(runner)
        return f"http://127.0.0.1:{port}"

    try:
        yield start_server
    finally:
        for runner in runners:
            await runner.cleanup()


async def test_fetch_url_basic_functionality(fetch_url_tool: FetchURL) -> None:
    """Test basic WebFetch functionality."""
    # Test with a reliable website that has content
    test_url = "https://github.com/MoonshotAI/Moonlight/issues/4"

    result = await fetch_url_tool(Params(url=test_url))

    assert not result.is_error
    assert result.output == snapshot(
        """\
---
title: Typo: adamw vs adamW · Issue #4 · MoonshotAI/Moonlight
author: MoonshotAI
url: https://github.com/MoonshotAI/Moonlight/issues/4
hostname: github.com
description: The default parameter value for optimizer should probably be adamw instead of adamW according to how get_optimizer is written.
sitename: GitHub
date: 2025-02-23
categories: ['issue:2873381615']
---
The default parameter value for `optimizer` should probably be `adamw` instead of `adamW` according to how `get_optimizer` is written.\
"""
    )


async def test_fetch_url_invalid_url(fetch_url_tool: FetchURL) -> None:
    """Test fetching from an invalid URL."""
    result = await fetch_url_tool(
        Params(url="https://this-domain-definitely-does-not-exist-12345.com/")
    )

    # Should fail with network error
    assert result.is_error
    assert "Failed to fetch URL due to network error:" in result.message


async def test_fetch_url_404_url(fetch_url_tool: FetchURL) -> None:
    """Test fetching from a URL that returns 404."""
    result = await fetch_url_tool(
        Params(url="https://github.com/MoonshotAI/non-existing-repo/issues/1")
    )

    # Should fail with HTTP error
    assert result.is_error
    assert result.message == snapshot(
        "Failed to fetch URL. Status: 404. This may indicate the page is not accessible or the server is down."
    )


async def test_fetch_url_malformed_url(fetch_url_tool: FetchURL) -> None:
    """Test fetching from a malformed URL."""
    result = await fetch_url_tool(Params(url="not-a-valid-url"))

    # Should fail
    assert result.is_error
    assert result.message == snapshot(
        "Failed to fetch URL due to network error: not-a-valid-url. This may indicate the URL is invalid or the server is unreachable."
    )


async def test_fetch_url_empty_url(fetch_url_tool: FetchURL) -> None:
    """Test fetching with empty URL."""
    result = await fetch_url_tool(Params(url=""))

    # Should fail
    assert result.is_error
    assert result.message == snapshot(
        "Failed to fetch URL due to network error: . This may indicate the URL is invalid or the server is unreachable."
    )


async def test_fetch_url_javascript_driven_site(fetch_url_tool: FetchURL) -> None:
    """Test fetching from a JavaScript-driven site that may not work with trafilatura."""
    result = await fetch_url_tool(Params(url="https://www.moonshot.ai/"))

    # This may fail due to JavaScript rendering requirements
    # If it fails, should indicate extraction issues
    if result.is_error:
        assert "failed to extract meaningful content" in result.message.lower()


async def test_fetch_url_mocked_http_responses(
    fetch_url_tool: FetchURL,
    mock_http_server: MockServerFactory,
) -> None:
    """Test fetching multiple mocked HTTP responses."""

    async def mocked_fetch(resp: str, *, content_type: str = "text/html") -> ToolReturnValue:
        server_url = await mock_http_server(resp, content_type=content_type)
        return await fetch_url_tool(Params(url=f"{server_url}/"))

    # plain markdown. Real example: https://lucumr.pocoo.org/2025/10/17/code.md
    plain_markdown = """\
# Title

This is a markdown document.
"""
    result = await mocked_fetch(plain_markdown, content_type="text/markdown; charset=utf-8")
    assert not result.is_error
    assert result.output == snapshot(plain_markdown)
    assert result.message == "The returned content is the full content of the page."

    # Real example: https://langfuse.com/docs.md
    complex_markdown = """\
---
title: Markdown Documentation
description: This is a sample markdown document with front-matter.
---

# Title

This is a markdown document.

<div><p>But has some html</p></div>
"""
    result = await mocked_fetch(
        complex_markdown,
        content_type="text/markdown; charset=utf-8",
    )
    assert not result.is_error
    assert result.output == snapshot(complex_markdown)
    assert result.message == "The returned content is the full content of the page."


async def test_fetch_url_with_service() -> None:
    """Test fetching using the moonshot_fetch service."""
    from kimi_cli.config import Config, MoonshotFetchConfig, Services
    from pydantic import SecretStr

    # Setup mock service response
    expected_content = "# Service Content\n\nThis content was fetched via the service."

    async def service_handler(request: web.Request) -> web.Response:
        # Verify request
        assert request.method == "POST"
        assert request.headers.get("Authorization") == "Bearer test-key"
        assert request.headers.get("Accept") == "text/markdown"
        assert request.headers.get("X-Custom-Header") == "custom-value"

        data = await request.json()
        assert data["url"] == "https://example.com"

        return web.Response(text=expected_content)

    # Create a mock server for the service
    app = web.Application()
    app.router.add_post("/fetch", service_handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host="127.0.0.1", port=0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]  # type: ignore
    service_url = f"http://127.0.0.1:{port}/fetch"

    try:
        # Configure tool with service
        config = Config(
            services=Services(
                moonshot_fetch=MoonshotFetchConfig(
                    base_url=service_url,
                    api_key=SecretStr("test-key"),
                    custom_headers={"X-Custom-Header": "custom-value"},
                )
            )
        )

        fetch_tool = FetchURL(config=config)

        # Execute fetch with tool call context
        from kimi_cli.wire.types import ToolCall
        from kimi_cli.soul.toolset import current_tool_call

        token = current_tool_call.set(
            ToolCall(
                id="test-call-id", function=ToolCall.FunctionBody(name="FetchURL", arguments=None)
            )
        )
        try:
            result = await fetch_tool(Params(url="https://example.com"))
        finally:
            current_tool_call.reset(token)

        assert not result.is_error
        assert result.output == expected_content
        assert result.message == snapshot(
            "The returned content is the main content extracted from the page."
        )

    finally:
        await runner.cleanup()
