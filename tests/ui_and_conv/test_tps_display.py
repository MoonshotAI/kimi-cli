"""Tests for TPS meter display conditionals."""

from pathlib import Path
from types import SimpleNamespace

import pytest
from kosong.tooling.empty import EmptyToolset

from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell.prompt import CustomPromptSession
from kimi_cli.ui.shell.visualize import _StatusBlock
from kimi_cli.ui.tps_meter import set_show_tps_meter
from kimi_cli.wire.types import StatusUpdate


@pytest.fixture(autouse=True)
def _reset_tps_meter():
    set_show_tps_meter(False)
    yield
    set_show_tps_meter(False)


def _make_status_snapshot(tps: float = 0.0) -> SimpleNamespace:
    return SimpleNamespace(
        context_usage=0.5,
        context_tokens=5000,
        max_context_tokens=10000,
        tps=tps,
    )


def test_render_right_span_shows_tps_when_enabled():
    """_render_right_span includes TPS when enabled and TPS > 0."""
    set_show_tps_meter(True)
    status = _make_status_snapshot(tps=12.3)

    result = CustomPromptSession._render_right_span(status)

    assert "12.3" in result or "tok/s" in result


def test_render_right_span_hides_tps_when_not_shown():
    """_render_right_span hides TPS when disabled or TPS is 0."""
    # When disabled (even with TPS > 0)
    set_show_tps_meter(False)
    status = _make_status_snapshot(tps=12.3)
    result = CustomPromptSession._render_right_span(status)
    assert "tok/s" not in result

    # When enabled but TPS is 0
    set_show_tps_meter(True)
    status = _make_status_snapshot(tps=0.0)
    result = CustomPromptSession._render_right_span(status)
    assert "tok/s" not in result


def test_status_block_shows_tps_when_enabled():
    """_StatusBlock includes TPS when enabled and TPS > 0."""
    set_show_tps_meter(True)
    status_update = StatusUpdate(
        context_usage=0.5,
        context_tokens=5000,
        max_context_tokens=10000,
        tps=15.5,
    )

    block = _StatusBlock(status_update)

    assert "15.5" in block.text.plain or "tok/s" in block.text.plain


def test_status_block_hides_tps_when_not_shown():
    """_StatusBlock hides TPS when disabled or TPS is 0."""
    # When disabled (even with TPS > 0)
    set_show_tps_meter(False)
    status_update = StatusUpdate(
        context_usage=0.5,
        context_tokens=5000,
        max_context_tokens=10000,
        tps=15.5,
    )
    block = _StatusBlock(status_update)
    assert "tok/s" not in block.text.plain

    # When enabled but TPS is 0
    set_show_tps_meter(True)
    status_update = StatusUpdate(context_usage=0.5, tps=0.0)
    block = _StatusBlock(status_update)
    assert "tok/s" not in block.text.plain
