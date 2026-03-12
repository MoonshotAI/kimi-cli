"""Tests for usage display color logic."""

from unittest.mock import patch

import pytest

from kimi_cli.ui.shell.usage import _format_row, _ratio_color, UsageRow


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


class TestFormatRow:
    """Tests for _format_row function."""

    @pytest.mark.parametrize(
        "used,limit,expected_ratio",
        [
            (0, 100, 0.0),     # 0% used -> boundary (green)
            (7, 100, 0.07),    # 7% used -> low usage (green)
            (50, 100, 0.5),    # 50% used -> low usage (green)
            (69, 100, 0.69),   # 69% used -> boundary (green)
            (70, 100, 0.7),    # 70% used -> boundary (yellow)
            (75, 100, 0.75),   # 75% used -> medium usage (yellow)
            (89, 100, 0.89),   # 89% used -> boundary (yellow)
            (90, 100, 0.9),    # 90% used -> boundary (red)
            (95, 100, 0.95),   # 95% used -> high usage (red)
            (100, 100, 1.0),   # 100% used -> boundary (red)
        ],
    )
    def test_format_row_passes_usage_ratio(self, used: int, limit: int, expected_ratio: float):
        """Test that _format_row passes usage ratio (used/limit) to _ratio_color."""
        row = UsageRow(label="Test", used=used, limit=limit)

        with patch("kimi_cli.ui.shell.usage._ratio_color") as mock_ratio_color:
            mock_ratio_color.return_value = "green"
            _format_row(row, label_width=10)

            mock_ratio_color.assert_called_once()
            actual_ratio = mock_ratio_color.call_args[0][0]
            assert abs(actual_ratio - expected_ratio) < 0.001, (
                f"Expected usage ratio {expected_ratio}, got {actual_ratio}"
            )

    def test_format_row_zero_limit(self):
        """Test _format_row handles zero limit gracefully."""
        row = UsageRow(label="Test", used=0, limit=0)

        # Should not raise and should display "N/A"
        result = _format_row(row, label_width=10)
        assert result is not None
