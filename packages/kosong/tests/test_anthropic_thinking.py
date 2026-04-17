"""Unit tests for Anthropic thinking mode dispatch."""

import pytest

pytest.importorskip("anthropic", reason="Optional contrib dependency not installed")

from kosong.contrib.chat_provider.anthropic import (
    _supports_adaptive_thinking,  # pyright: ignore[reportPrivateUsage]
)


@pytest.mark.parametrize(
    "model,expected",
    [
        # Opus 4.7 family (adaptive-only per Anthropic docs)
        ("claude-opus-4-7", True),
        ("claude-opus-4-7-20260301", True),
        ("claude-opus-4.7", True),
        ("CLAUDE-OPUS-4-7", True),  # case-insensitive
        # Opus 4.6 / Sonnet 4.6 (adaptive preferred)
        ("claude-opus-4-6", True),
        ("claude-opus-4-6-20260205", True),
        ("claude-opus-4.6", True),
        ("claude-sonnet-4-6", True),
        ("claude-sonnet-4-6-20260301", True),
        ("claude-sonnet-4.6", True),
        # Mythos Preview (no version number, explicit marker)
        ("claude-mythos-preview", True),
        ("claude-mythos", True),
        # Future version extrapolation (regex-driven)
        ("claude-opus-4-8", True),
        ("claude-opus-4-9", True),
        ("claude-opus-4-10", True),  # two-digit minor
        ("claude-opus-5-0", True),
        ("claude-opus-5-0-20270101", True),
        ("claude-sonnet-5-0", True),
        ("claude-haiku-4-6", True),  # haiku family nominally included if >= 4.6
        ("claude-haiku-5-0", True),
        # Bedrock / Vertex / proxy prefixes must not defeat detection
        ("anthropic.claude-opus-4-7-v1:0", True),
        ("aws/claude-opus-4-7", True),
        ("bedrock/anthropic.claude-opus-4-6-v1:0", True),
        ("claude-opus-4-7@20260101", True),
        # Pre-4.6 models (legacy budget_tokens required)
        ("claude-opus-4", False),
        ("claude-opus-4-0", False),
        ("claude-opus-4-5", False),
        ("claude-opus-4-5-20251001", False),
        ("claude-opus-3-5", False),
        ("claude-opus-3-5-sonnet-20241022", False),  # edge: embedded "sonnet"
        ("claude-sonnet-4-20250514", False),  # Sonnet 4 with date, no minor
        ("claude-sonnet-4-5", False),
        ("claude-sonnet-4-5-20250929", False),
        ("claude-sonnet-3-5", False),
        ("claude-sonnet-3-7", False),
        ("claude-haiku-3-5", False),
        ("claude-haiku-4-5", False),
        ("claude-haiku-4-5-20251001", False),
        # Non-Claude models / garbage input
        ("gpt-4", False),
        ("gpt-4-turbo", False),
        ("gemini-2.5-pro", False),
        ("", False),
        ("unknown-model", False),
        ("claude", False),  # no family word
    ],
)
def test_supports_adaptive_thinking(model: str, expected: bool) -> None:
    assert _supports_adaptive_thinking(model) is expected
