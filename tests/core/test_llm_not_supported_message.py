"""The capability error must name the config setting that fixes it.

Capabilities like `image_in` are only picked up from a model's `capabilities`
entry for manually configured models, so an error that just states the missing
capability leaves the user with no way to act on it.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from kimi_cli.soul import LLMNotSupported


def _message(*capabilities: str) -> str:
    llm = MagicMock()
    llm.model_name = "Qwen3.6-27B"
    return str(LLMNotSupported(llm, list(capabilities)))  # type: ignore[arg-type]


def test_single_capability_message_points_at_the_config_fix() -> None:
    message = _message("image_in")

    assert "Qwen3.6-27B" in message
    assert "does not support required capability: image_in" in message
    assert 'capabilities = ["image_in"]' in message


def test_multiple_capabilities_are_listed_in_the_suggested_setting() -> None:
    message = _message("video_in", "image_in")

    assert "does not support required capabilities:" in message
    # Sorted so the suggestion is stable regardless of set iteration order.
    assert 'capabilities = ["image_in", "video_in"]' in message
