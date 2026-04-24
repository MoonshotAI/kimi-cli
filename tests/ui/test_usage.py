"""Tests for shell usage rendering helpers."""

from __future__ import annotations

import pytest

from kimi_cli.ui.shell.usage import _ratio_color


@pytest.mark.parametrize(
    ("ratio", "expected"),
    [
        (1.0, "green"),
        (0.31, "green"),
        (0.3, "yellow"),
        (0.11, "yellow"),
        (0.1, "red"),
        (0.0, "red"),
        (-0.1, "red"),
    ],
)
def test_ratio_color_uses_remaining_quota_ratio(ratio: float, expected: str) -> None:
    """Remaining quota should only become dangerous near exhaustion."""
    assert _ratio_color(ratio) == expected
