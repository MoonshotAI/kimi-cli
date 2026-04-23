"""Tests for shell usage rendering helpers."""

from __future__ import annotations

import pytest

from kimi_cli.ui.shell.usage import _ratio_color


@pytest.mark.parametrize(
    ("ratio", "expected"),
    [
        (1.0, "green"),
        (0.95, "green"),
        (0.9, "green"),
        (0.8, "yellow"),
        (0.7, "yellow"),
        (0.69, "red"),
        (0.1, "red"),
        (-0.1, "red"),
    ],
)
def test_ratio_color_uses_remaining_quota_ratio(ratio: float, expected: str) -> None:
    """Higher remaining ratio should be safer, not more dangerous."""
    assert _ratio_color(ratio) == expected
