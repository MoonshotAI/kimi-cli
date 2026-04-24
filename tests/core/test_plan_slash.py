"""Tests for /plan slash command."""

from __future__ import annotations

from pathlib import Path

import pytest
from kosong.tooling.empty import EmptyToolset

from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.slash import plan
from kimi_cli.tools.plan.heroes import _slug_cache
from kimi_cli.wire.types import TextPart


@pytest.fixture(autouse=True)
def _clear_slug_cache():
    _slug_cache.clear()
    yield
    _slug_cache.clear()


def _make_soul(runtime: Runtime, tmp_path: Path) -> KimiSoul:
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    return KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))


async def _run_plan(soul: KimiSoul, args: str) -> None:
    result = plan(soul, args)
    if result is not None:
        await result


class TestPlanSlashCommand:
    async def test_plan_on(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes._get_plans_dir", lambda: tmp_path)
        soul = _make_soul(runtime, tmp_path)
        sent: list[TextPart] = []
        monkeypatch.setattr("kimi_cli.soul.slash.wire_send", lambda msg: sent.append(msg))

        await _run_plan(soul, "on")

        assert soul.plan_mode is True
        assert any("Plan mode ON" in s.text for s in sent)

    async def test_plan_on_idempotent(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes._get_plans_dir", lambda: tmp_path)
        soul = _make_soul(runtime, tmp_path)
        sent: list[TextPart] = []
        monkeypatch.setattr("kimi_cli.soul.slash.wire_send", lambda msg: sent.append(msg))

        await _run_plan(soul, "on")
        await _run_plan(soul, "on")

        assert soul.plan_mode is True

    async def test_plan_off(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes._get_plans_dir", lambda: tmp_path)
        soul = _make_soul(runtime, tmp_path)
        sent: list[TextPart] = []
        monkeypatch.setattr("kimi_cli.soul.slash.wire_send", lambda msg: sent.append(msg))

        await _run_plan(soul, "on")
        sent.clear()
        await _run_plan(soul, "off")

        assert soul.plan_mode is False
        assert any("Plan mode OFF" in s.text for s in sent)

    async def test_plan_off_idempotent(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes._get_plans_dir", lambda: tmp_path)
        soul = _make_soul(runtime, tmp_path)
        sent: list[TextPart] = []
        monkeypatch.setattr("kimi_cli.soul.slash.wire_send", lambda msg: sent.append(msg))

        await _run_plan(soul, "off")

        assert soul.plan_mode is False
        assert any("Plan mode OFF" in s.text for s in sent)

    async def test_plan_view_with_content(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes._get_plans_dir", lambda: tmp_path)
        soul = _make_soul(runtime, tmp_path)
        sent: list[TextPart] = []
        monkeypatch.setattr("kimi_cli.soul.slash.wire_send", lambda msg: sent.append(msg))

        await _run_plan(soul, "on")
        plan_path = soul.get_plan_file_path()
        assert plan_path is not None
        plan_path.parent.mkdir(parents=True, exist_ok=True)
        plan_path.write_text("# My Plan\nStep 1", encoding="utf-8")

        sent.clear()
        await _run_plan(soul, "view")

        assert any("# My Plan" in s.text for s in sent)

    async def test_plan_view_no_content(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes._get_plans_dir", lambda: tmp_path)
        soul = _make_soul(runtime, tmp_path)
        sent: list[TextPart] = []
        monkeypatch.setattr("kimi_cli.soul.slash.wire_send", lambda msg: sent.append(msg))

        await _run_plan(soul, "on")
        sent.clear()
        await _run_plan(soul, "view")

        assert any("No plan file found" in s.text for s in sent)

    async def test_plan_clear(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes._get_plans_dir", lambda: tmp_path)
        soul = _make_soul(runtime, tmp_path)
        sent: list[TextPart] = []
        monkeypatch.setattr("kimi_cli.soul.slash.wire_send", lambda msg: sent.append(msg))

        await _run_plan(soul, "on")
        plan_path = soul.get_plan_file_path()
        assert plan_path is not None
        plan_path.parent.mkdir(parents=True, exist_ok=True)
        plan_path.write_text("# Plan", encoding="utf-8")

        sent.clear()
        await _run_plan(soul, "clear")

        assert not plan_path.exists()
        assert any("Plan cleared" in s.text for s in sent)

    async def test_plan_toggle_on(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes._get_plans_dir", lambda: tmp_path)
        soul = _make_soul(runtime, tmp_path)
        sent: list[TextPart] = []
        monkeypatch.setattr("kimi_cli.soul.slash.wire_send", lambda msg: sent.append(msg))

        await _run_plan(soul, "")

        assert soul.plan_mode is True
        assert any("Plan mode ON" in s.text for s in sent)

    async def test_plan_toggle_off(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes._get_plans_dir", lambda: tmp_path)
        soul = _make_soul(runtime, tmp_path)
        sent: list[TextPart] = []
        monkeypatch.setattr("kimi_cli.soul.slash.wire_send", lambda msg: sent.append(msg))

        await _run_plan(soul, "on")
        sent.clear()
        await _run_plan(soul, "")

        assert soul.plan_mode is False
        assert any("Plan mode OFF" in s.text for s in sent)
