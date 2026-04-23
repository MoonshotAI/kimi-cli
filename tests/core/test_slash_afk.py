"""Tests for /afk and /yolo slash command independence."""

from __future__ import annotations

from pathlib import Path

import pytest
from kosong.tooling.empty import EmptyToolset

from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.slash import afk as afk_slash
from kimi_cli.soul.slash import yolo as yolo_slash
from kimi_cli.wire.types import TextPart


def _make_soul(runtime: Runtime, tmp_path: Path) -> KimiSoul:
    # The shared `approval` fixture in conftest defaults to yolo=True; reset both
    # flags so each test starts from a clean state.
    runtime.approval.set_yolo(False)
    runtime.approval.set_afk(False)
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    return KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))


async def _run(fn, soul: KimiSoul, args: str = "") -> None:
    result = fn(soul, args)
    if result is not None:
        await result


async def test_afk_slash_toggles_afk_flag(
    runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    soul = _make_soul(runtime, tmp_path)
    sent: list[TextPart] = []
    monkeypatch.setattr("kimi_cli.soul.slash.wire_send", lambda msg: sent.append(msg))

    # Starts off; toggle on.
    assert soul.runtime.approval.is_afk() is False
    await _run(afk_slash, soul)
    assert soul.runtime.approval.is_afk() is True
    assert any("afk" in s.text.lower() and "enabled" in s.text.lower() for s in sent)

    # Toggle off.
    sent.clear()
    await _run(afk_slash, soul)
    assert soul.runtime.approval.is_afk() is False
    assert any("afk" in s.text.lower() and "disabled" in s.text.lower() for s in sent)


async def test_afk_slash_does_not_touch_yolo_flag(
    runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    soul = _make_soul(runtime, tmp_path)
    soul.runtime.approval.set_yolo(True)
    monkeypatch.setattr("kimi_cli.soul.slash.wire_send", lambda _msg: None)

    await _run(afk_slash, soul)

    assert soul.runtime.approval.is_afk() is True
    # yolo flag untouched.
    assert soul.runtime.approval.is_yolo_flag() is True


async def test_yolo_slash_under_afk_only_toggles_yolo_flag(
    runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: /yolo under afk-only used to fire the 'require approval' branch
    and claim approval is now required, while afk kept auto-approving.
    /yolo must inspect only the yolo flag, not the OR-combined is_yolo()."""
    soul = _make_soul(runtime, tmp_path)
    # Afk on, yolo flag off -> is_yolo() True via OR, but yolo_flag is False.
    soul.runtime.approval._state.afk = True  # pyright: ignore[reportPrivateUsage]
    assert soul.runtime.approval.is_yolo() is True
    assert soul.runtime.approval.is_yolo_flag() is False

    sent: list[TextPart] = []
    monkeypatch.setattr("kimi_cli.soul.slash.wire_send", lambda msg: sent.append(msg))

    await _run(yolo_slash, soul)

    # /yolo flipped the yolo flag ON (since flag was False).
    assert soul.runtime.approval.is_yolo_flag() is True
    # Afk untouched.
    assert soul.runtime.approval.is_afk() is True
    # Toast must reflect yolo being turned ON, not the misleading "require approval".
    assert any("auto-approved" in s.text.lower() for s in sent)
    assert not any("require approval" in s.text.lower() for s in sent)


async def test_yolo_slash_with_no_flags_turns_yolo_on(
    runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Plain /yolo on a clean state: flag goes True, toast says auto-approve."""
    soul = _make_soul(runtime, tmp_path)
    sent: list[TextPart] = []
    monkeypatch.setattr("kimi_cli.soul.slash.wire_send", lambda msg: sent.append(msg))

    await _run(yolo_slash, soul)
    assert soul.runtime.approval.is_yolo_flag() is True
    assert any("auto-approved" in s.text.lower() for s in sent)

    # Second call: flag off, toast says approval required.
    sent.clear()
    await _run(yolo_slash, soul)
    assert soul.runtime.approval.is_yolo_flag() is False
    assert any("require approval" in s.text.lower() for s in sent)


async def test_status_snapshot_separates_yolo_and_afk(runtime: Runtime, tmp_path: Path) -> None:
    """Status bar must tell yolo_enabled and afk_enabled apart.

    Previously `yolo_enabled` was `is_yolo()` (OR'ed with afk), which showed 'yolo'
    in the status bar even when only afk was on. Now yolo_enabled only reflects
    the explicit yolo flag.
    """
    soul = _make_soul(runtime, tmp_path)

    # Afk only -> afk_enabled True, yolo_enabled False.
    soul.runtime.approval._state.afk = True  # pyright: ignore[reportPrivateUsage]
    snap = soul.status
    assert snap.afk_enabled is True
    assert snap.yolo_enabled is False

    # Add yolo flag on top -> both True.
    soul.runtime.approval.set_yolo(True)
    snap = soul.status
    assert snap.afk_enabled is True
    assert snap.yolo_enabled is True
