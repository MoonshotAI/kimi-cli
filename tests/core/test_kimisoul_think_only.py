"""Tests for think-only response error handling.

A model response containing only ThinkPart content (no TextPart, no tool_calls)
is an abnormal condition — typically a stream interruption or output token budget
exhaustion during reasoning. This should be detected as an error at the generate
layer and retried through the standard retry mechanism.
"""

from __future__ import annotations

import pytest
from kosong.chat_provider import APIEmptyResponseError

from kimi_cli.soul.kimisoul import KimiSoul


@pytest.mark.asyncio
async def test_think_only_error_is_retryable() -> None:
    """APIEmptyResponseError from think-only responses should be retryable."""
    assert KimiSoul._is_retryable_error(APIEmptyResponseError("only thinking content"))
