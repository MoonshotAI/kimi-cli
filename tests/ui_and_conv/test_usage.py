"""Tests for usage display color logic."""

import pytest

from kimi_cli.ui.shell.usage import _ratio_color


class TestRatioColor:
    """Tests for _ratio_color function."""

    @pytest.mark.parametrize(
        "ratio,expected,description",
        [
            # Low usage -> green
            (0.0, "green", "0% used"),
            (0.07, "green", "7% used, plenty left"),
            (0.5, "green", "50% used, still ok"),
            (0.69, "green", "69% used, boundary"),
            # Medium usage -> yellow
            (0.7, "yellow", "70% used, warning zone"),
            (0.75, "yellow", "75% used"),
            (0.89, "yellow", "89% used, boundary"),
            # High usage -> red
            (0.9, "red", "90% used, danger zone"),
            (0.95, "red", "95% used"),
            (1.0, "red", "100% used, exhausted"),
        ],
    )
    def test_ratio_color(self, ratio: float, expected: str, description: str):
        """Test color for various usage ratios."""
        assert _ratio_color(ratio) == expected, f"Failed for {description}"
