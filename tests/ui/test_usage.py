from __future__ import annotations

import pytest
from rich.console import Console
from rich.segment import Segment

from kimi_cli.ui.shell.usage import UsageRow, _format_row, _ratio_color, _remaining_quota, _to_int


def _render_segments(row: UsageRow, label_width: int = 6) -> list[Segment]:
    console = Console(force_terminal=True, color_system="standard", width=80)
    return console.render_lines(
        _format_row(row, label_width=label_width),
        console.options,
        style=None,
    )[0]


def _plain_text(segments: list[Segment]) -> str:
    return "".join(segment.text for segment in segments).rstrip()


def _filled_bar_segments(segments: list[Segment]) -> list[Segment]:
    return [segment for segment in segments if "━" in segment.text]


@pytest.mark.parametrize(
    ("remaining_ratio", "expected"),
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
def test_ratio_color_uses_remaining_quota_ratio(remaining_ratio: float, expected: str) -> None:
    assert _ratio_color(remaining_ratio) == expected


@pytest.mark.parametrize(
    ("used", "limit", "expected_remaining", "expected_ratio", "expected_total"),
    [
        (0, 100, 100, 1.0, 100),
        (30, 100, 70, 0.7, 100),
        (70, 100, 30, 0.3, 100),
        (90, 100, 10, 0.1, 100),
        (100, 100, 0, 0.0, 100),
        (150, 100, 0, 0.0, 100),
        (-20, 100, 100, 1.0, 100),
        (0, 0, 0, 0.0, 1),
        (0, -10, 0, 0.0, 1),
    ],
)
def test_remaining_quota_clamps_unusual_api_values(
    used: int,
    limit: int,
    expected_remaining: int,
    expected_ratio: float,
    expected_total: int,
) -> None:
    row = UsageRow(label="Weekly", used=used, limit=limit)

    remaining, ratio, total = _remaining_quota(row)

    assert remaining == expected_remaining
    assert ratio == pytest.approx(expected_ratio)
    assert total == expected_total


@pytest.mark.parametrize(
    ("used", "limit", "expected_bar_width", "expected_color", "expected_text"),
    [
        (0, 100, 20, "green", "100% left"),
        (30, 100, 14, "green", "70% left"),
        (70, 100, 6, "yellow", "30% left"),
        (90, 100, 2, "red", "10% left"),
    ],
)
def test_format_row_renders_remaining_quota(
    used: int,
    limit: int,
    expected_bar_width: int,
    expected_color: str,
    expected_text: str,
) -> None:
    segments = _render_segments(UsageRow(label="Weekly", used=used, limit=limit))
    bar_segments = _filled_bar_segments(segments)

    assert _plain_text(segments).startswith("Weekly  ")
    assert expected_text in _plain_text(segments)
    assert len(bar_segments) == 1
    assert bar_segments[0].text == "━" * expected_bar_width
    assert str(bar_segments[0].style) == expected_color


@pytest.mark.parametrize(("used", "limit"), [(0, 0), (0, -10), (100, 100), (150, 100)])
def test_format_row_handles_no_remaining_quota(used: int, limit: int) -> None:
    segments = _render_segments(UsageRow(label="Weekly", used=used, limit=limit))

    assert "0% left" in _plain_text(segments)
    assert _filled_bar_segments(segments) == []


def test_format_row_renders_reset_hint() -> None:
    row = UsageRow(label="Weekly", used=30, limit=100, reset_hint="resets in 1h")

    assert "resets in 1h" in _plain_text(_render_segments(row))


@pytest.mark.parametrize("value", ["42", 42, 42.0])
def test_to_int_accepts_integer_values(value: object) -> None:
    assert _to_int(value) == 42


@pytest.mark.parametrize("value", [None, "unknown", float("nan"), float("inf"), float("-inf")])
def test_to_int_rejects_invalid_values(value: object) -> None:
    assert _to_int(value) is None
