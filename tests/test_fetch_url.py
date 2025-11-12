# ruff: noqa

"""Tests for WebFetch tool."""

from __future__ import annotations

import pytest
from inline_snapshot import snapshot
from kosong.tooling import ToolError, ToolOk

from kimi_cli.tools.web.fetch import FetchURL, Params


@pytest.mark.asyncio
async def test_fetch_url_basic_functionality(fetch_url_tool: FetchURL) -> None:
    """Test basic WebFetch functionality."""
    # Test with a reliable website that has content
    test_url = "https://github.com/MoonshotAI/Moonlight/issues/4"

    result = await fetch_url_tool(Params(url=test_url))

    assert isinstance(result, ToolOk)
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


@pytest.mark.asyncio
async def test_fetch_url_invalid_url(fetch_url_tool: FetchURL) -> None:
    """Test fetching from an invalid URL."""
    result = await fetch_url_tool(
        Params(url="https://this-domain-definitely-does-not-exist-12345.com/")
    )

    # Should fail with network error
    assert isinstance(result, ToolError)
    assert "Failed to fetch URL due to network error:" in result.message


@pytest.mark.asyncio
async def test_fetch_url_404_url(fetch_url_tool: FetchURL) -> None:
    """Test fetching from a URL that returns 404."""
    result = await fetch_url_tool(
        Params(url="https://github.com/MoonshotAI/non-existing-repo/issues/1")
    )

    # Should fail with HTTP error
    assert isinstance(result, ToolError)
    assert result.message == snapshot(
        "Failed to fetch URL. Status: 404. This may indicate the page is not accessible or the server is down."
    )


@pytest.mark.asyncio
async def test_fetch_url_malformed_url(fetch_url_tool: FetchURL) -> None:
    """Test fetching from a malformed URL."""
    result = await fetch_url_tool(Params(url="not-a-valid-url"))

    # Should fail
    assert isinstance(result, ToolError)
    assert result.message == snapshot(
        "Failed to fetch URL due to network error: not-a-valid-url. This may indicate the URL is invalid or the server is unreachable."
    )


@pytest.mark.asyncio
async def test_fetch_url_empty_url(fetch_url_tool: FetchURL) -> None:
    """Test fetching with empty URL."""
    result = await fetch_url_tool(Params(url=""))

    # Should fail
    assert isinstance(result, ToolError)
    assert result.message == snapshot(
        "Failed to fetch URL due to network error: . This may indicate the URL is invalid or the server is unreachable."
    )


@pytest.mark.asyncio
async def test_fetch_url_javascript_driven_site(fetch_url_tool: FetchURL) -> None:
    """Test fetching from a JavaScript-driven site that may not work with trafilatura."""
    result = await fetch_url_tool(Params(url="https://www.moonshot.ai/"))

    # This may fail due to JavaScript rendering requirements
    # If it fails, should indicate extraction issues
    if isinstance(result, ToolError):
        assert "failed to extract meaningful content" in result.message.lower()
