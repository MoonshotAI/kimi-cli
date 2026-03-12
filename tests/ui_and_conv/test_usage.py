"""Tests for usage display color logic."""

import pytest

from kimi_cli.ui.shell.usage import _ratio_color


class TestRatioColor:
    """Tests for _ratio_color function."""

    def test_low_usage_returns_green(self):
        """When less than 70% is used, should return green."""
        assert _ratio_color(0.0) == "green"
        assert _ratio_color(0.5) == "green"
        assert _ratio_color(0.69) == "green"

    def test_medium_usage_returns_yellow(self):
        """When between 70% and 90% is used, should return yellow."""
        assert _ratio_color(0.7) == "yellow"
        assert _ratio_color(0.8) == "yellow"
        assert _ratio_color(0.89) == "yellow"

    def test_high_usage_returns_red(self):
        """When 90% or more is used, should return red."""
        assert _ratio_color(0.9) == "red"
        assert _ratio_color(0.95) == "red"
        assert _ratio_color(1.0) == "red"

    @pytest.mark.parametrize(
        "ratio,expected",
        [
            # Low usage -> green
            (0.07, "green"),  # 7% used, plenty left
            (0.5, "green"),  # 50% used, still ok
            (0.69, "green"),  # 69% used, boundary case
            # Medium usage -> yellow
            (0.7, "yellow"),  # 70% used, warning zone
            (0.75, "yellow"),  # 75% used
            (0.89, "yellow"),  # 89% used, boundary case
            # High usage -> red
            (0.9, "red"),  # 90% used, danger zone
            (0.95, "red"),  # 95% used
            (1.0, "red"),  # 100% used, exhausted
        ],
    )
    def test_ratio_color_boundaries(self, ratio: float, expected: str):
        """Test color boundaries for various usage ratios."""
        assert _ratio_color(ratio) == expected
