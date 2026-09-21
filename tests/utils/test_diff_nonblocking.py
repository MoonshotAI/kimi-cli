"""Tests for non-blocking diff computation (Plan A) and large-file optimization (Plan C)."""

from __future__ import annotations

from collections.abc import Sequence
from unittest.mock import AsyncMock, patch

from kosong.tooling import DisplayBlock

from kimi_cli.utils.diff import (
    _HUGE_FILE_THRESHOLD,
    _build_diff_blocks_sync,
    build_diff_blocks,
)
from kimi_cli.wire.types import DiffDisplayBlock


def _make_lines(n: int, prefix: str = "Line") -> str:
    return "\n".join(f"{prefix} {i}" for i in range(n))


def _as_diff(blocks: Sequence[DisplayBlock]) -> list[DiffDisplayBlock]:
    """Narrow a list of DisplayBlock to DiffDisplayBlock for type-safe access."""
    result: list[DiffDisplayBlock] = []
    for b in blocks:
        assert isinstance(b, DiffDisplayBlock)
        result.append(b)
    return result


# ---------------------------------------------------------------------------
# Plan A: build_diff_blocks delegates to asyncio.to_thread
# ---------------------------------------------------------------------------


async def test_build_diff_blocks_delegates_to_thread() -> None:
    """build_diff_blocks must call asyncio.to_thread with _build_diff_blocks_sync."""
    old = "line1\nline2\nline3"
    new = "line1\nchanged\nline3"

    sentinel = [DiffDisplayBlock(path="x", old_text="a", new_text="b")]

    with patch("kimi_cli.utils.diff.asyncio") as mock_asyncio:
        mock_asyncio.to_thread = AsyncMock(return_value=sentinel)
        result = await build_diff_blocks("/tmp/test.txt", old, new)

    mock_asyncio.to_thread.assert_awaited_once_with(
        _build_diff_blocks_sync, "/tmp/test.txt", old, new
    )
    assert result is sentinel


# ---------------------------------------------------------------------------
# Plan C: large-file threshold behaviour
# ---------------------------------------------------------------------------


async def test_large_file_diff_is_precise() -> None:
    """Files below _HUGE_FILE_THRESHOLD should produce a precise diff
    (autojunk=False) that includes the actual changed content."""
    n = 3000
    old = _make_lines(n)
    changed_line = f"Changed {n // 2}"
    new = old.replace(f"Line {n // 2}", changed_line)

    diff_blocks = _as_diff(await build_diff_blocks("/tmp/large.txt", old, new))

    assert len(diff_blocks) > 0
    assert any(changed_line in b.new_text for b in diff_blocks)


async def test_huge_file_returns_summary() -> None:
    """Files above _HUGE_FILE_THRESHOLD should skip diff and return a summary
    for both modification and creation scenarios."""
    n = _HUGE_FILE_THRESHOLD + 100

    # Scenario 1: modify existing huge file (different line counts)
    old = _make_lines(n)
    new = _make_lines(n + 50, prefix="Changed")
    diff_blocks = _as_diff(await build_diff_blocks("/tmp/huge.txt", old, new))

    assert len(diff_blocks) == 1
    block = diff_blocks[0]
    assert block.is_summary is True
    assert f"{n}" in block.old_text and "lines" in block.old_text
    assert f"{n + 50}" in block.new_text and "lines" in block.new_text

    # Scenario 2: create new huge file (old is empty)
    diff_blocks = _as_diff(await build_diff_blocks("/tmp/huge_new.txt", "", new))

    assert len(diff_blocks) == 1
    assert diff_blocks[0].is_summary is True
    assert "lines" in diff_blocks[0].new_text
    assert "0" in diff_blocks[0].old_text or "lines" in diff_blocks[0].old_text


async def test_huge_file_same_line_count_shows_modified() -> None:
    """When a huge file is modified but line count stays the same,
    the summary must convey 'modified' to avoid looking like no change."""
    n = _HUGE_FILE_THRESHOLD + 100
    old = _make_lines(n)
    new = _make_lines(n, prefix="Changed")

    diff_blocks = _as_diff(await build_diff_blocks("/tmp/huge_same.txt", old, new))

    assert len(diff_blocks) == 1
    block = diff_blocks[0]
    assert block.is_summary is True
    assert "modified" in block.new_text


async def test_threshold_boundary() -> None:
    """Files with exactly _HUGE_FILE_THRESHOLD lines should produce a normal diff,
    not a summary (threshold uses strict '>')."""
    n = _HUGE_FILE_THRESHOLD
    old = _make_lines(n)
    changed_line = f"Changed {n // 2}"
    new = old.replace(f"Line {n // 2}", changed_line)

    diff_blocks = _as_diff(await build_diff_blocks("/tmp/boundary_huge.txt", old, new))
    assert len(diff_blocks) > 0
    assert all(not b.is_summary for b in diff_blocks)
    assert any(changed_line in b.new_text for b in diff_blocks)


async def test_unchanged_huge_file_returns_empty() -> None:
    """When old_text == new_text (even for huge files), no diff blocks should
    be produced — the early-exit short-circuit must fire before the
    _HUGE_FILE_THRESHOLD summary path."""
    n = _HUGE_FILE_THRESHOLD + 100
    content = _make_lines(n)

    blocks = await build_diff_blocks("/tmp/unchanged_huge.txt", content, content)

    assert blocks == [], "Unchanged content must produce no diff blocks"


# ---------------------------------------------------------------------------
# Summary block rendering
# ---------------------------------------------------------------------------


def test_summary_panel_renders_modification() -> None:
    """Summary panel for modifying a huge file should show line count transition."""
    from rich.panel import Panel

    from kimi_cli.utils.rich.diff_render import render_diff_summary_panel

    block = DiffDisplayBlock(
        path="huge.py",
        old_text="(10000 lines)",
        new_text="(10100 lines)",
        is_summary=True,
    )
    panel = render_diff_summary_panel("huge.py", [block])
    assert isinstance(panel, Panel)


def test_summary_panel_renders_new_file() -> None:
    """Summary panel for creating a huge file should say 'New file'."""
    from kimi_cli.utils.rich.diff_render import _summary_description

    block = DiffDisplayBlock(
        path="huge.py",
        old_text="(0 lines)",
        new_text="(10100 lines)",
        is_summary=True,
    )
    desc = _summary_description([block])
    assert "New file" in desc
    assert "10100" in desc


def test_summary_preview_returns_renderables() -> None:
    """Summary preview should return compact renderables for approval panel."""
    from kimi_cli.utils.rich.diff_render import render_diff_summary_preview

    block = DiffDisplayBlock(
        path="huge.py",
        old_text="(5000 lines)",
        new_text="(5100 lines)",
        is_summary=True,
    )
    renderables = render_diff_summary_preview("huge.py", [block])
    assert len(renderables) == 2
    # Second line should contain the description
    text = str(renderables[1])
    assert "too large" in text.lower() or "inline diff" in text.lower()
