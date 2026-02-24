"""Tests for bell_on_completion feature in visualize."""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock, patch

import pytest

from kimi_cli.ui.shell.visualize import _LiveView
from kimi_cli.wire.types import StatusUpdate, TurnEnd


@pytest.mark.asyncio
async def test_turn_end_plays_bell_when_enabled():
    """Test that bell is played on TurnEnd when bell_on_completion=True."""
    view = _LiveView(
        initial_status=StatusUpdate(),
        cancel_event=None,
        bell_on_completion=True,
    )

    with patch("kimi_cli.ui.shell.visualize.console.bell") as mock_bell:
        view.dispatch_wire_message(TurnEnd())
        mock_bell.assert_called_once()


@pytest.mark.asyncio
async def test_turn_end_does_not_play_bell_when_disabled():
    """Test that bell is not played on TurnEnd when bell_on_completion=False."""
    view = _LiveView(
        initial_status=StatusUpdate(),
        cancel_event=None,
        bell_on_completion=False,
    )

    with patch("kimi_cli.ui.shell.visualize.console.bell") as mock_bell:
        view.dispatch_wire_message(TurnEnd())
        mock_bell.assert_not_called()


def test_live_view_default_bell_on_completion():
    """Test that _LiveView defaults to bell_on_completion=True."""
    view = _LiveView(initial_status=StatusUpdate())
    assert view._bell_on_completion is True
