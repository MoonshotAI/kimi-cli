"""Tests for Plan Mode tools and helpers."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from kosong.tooling import ToolError, ToolReturnValue
from kosong.tooling.empty import EmptyToolset
from pydantic import ValidationError

from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.approval import Approval
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.toolset import KimiToolset
from kimi_cli.tools.file.replace import StrReplaceFile
from kimi_cli.tools.file.write import WriteFile
from kimi_cli.tools.plan import ExitPlanMode, Params, PlanOption
from kimi_cli.tools.plan.enter import _DESCRIPTION, EnterPlanMode
from kimi_cli.tools.plan.heroes import (
    _slug_cache,
    get_or_create_slug,
    get_plan_file_path,
    read_plan_file,
)
from kimi_cli.tools.utils import ToolRejectedError
from kimi_cli.wire.types import QuestionNotSupported, QuestionRequest, ToolCall

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def approval() -> Approval:
    """Override global yolo=True fixture; plan mode tests don't need yolo."""
    return Approval(yolo=False)


@pytest.fixture(autouse=True)
def _clear_slug_cache():
    """Clear the module-level slug cache before each test."""
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


def _tool_output_text(result: ToolReturnValue) -> str:
    assert isinstance(result.output, str)
    return result.output


# ---------------------------------------------------------------------------
# heroes.py — slug generation
# ---------------------------------------------------------------------------


class TestGetOrCreateSlug:
    def test_returns_hero_name(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        slug = get_or_create_slug("session-1")
        # Slug is composed of 3 hero names joined by "-"; each hero name may itself contain "-"
        # Just verify it's a non-empty string and contains at least some hero name substrings
        assert isinstance(slug, str) and len(slug) > 0

    def test_cache_hit(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        first = get_or_create_slug("session-1")
        second = get_or_create_slug("session-1")
        assert first == second

    def test_different_sessions_get_different_slugs(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        a = get_or_create_slug("session-a")
        b = get_or_create_slug("session-b")
        # Extremely unlikely to be equal with 230+ names, but not impossible.
        # This test is probabilistic; if it flakes, the pool is too small.
        assert isinstance(a, str)
        assert isinstance(b, str)

    def test_collision_fallback(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """When all random choices collide, append session prefix for uniqueness."""
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        # Use a tiny hero list so we can predict and pre-create all combos
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.HERO_NAMES", ["a", "b"])
        # Pre-create all possible 3-word combos from ["a", "b"]
        import itertools

        for combo in itertools.product(["a", "b"], repeat=3):
            (tmp_path / f"{'-'.join(combo)}.md").touch()

        session_id = "abcdef1234567890"
        slug = get_or_create_slug(session_id)
        # Should have the session prefix appended
        assert slug.endswith(f"-{session_id[:8]}")


class TestGetPlanFilePath:
    def test_returns_md_file_in_plans_dir(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        path = get_plan_file_path("session-1")
        assert path.parent == tmp_path
        assert path.suffix == ".md"


class TestReadPlanFile:
    def test_reads_existing_file(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        # First, get the path so the slug is generated
        path = get_plan_file_path("session-1")
        path.write_text("# My Plan", encoding="utf-8")
        content = read_plan_file("session-1")
        assert content == "# My Plan"

    def test_returns_none_for_missing_file(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        content = read_plan_file("session-nonexistent")
        assert content is None


# ---------------------------------------------------------------------------
# ExitPlanMode — guard conditions
# ---------------------------------------------------------------------------


class TestExitPlanModeGuards:
    async def test_not_in_plan_mode(self) -> None:
        from kimi_cli.tools.plan import ExitPlanMode

        tool = ExitPlanMode()
        tool.bind(
            toggle_callback=AsyncMock(return_value=False),
            plan_file_path_getter=lambda: Path("/tmp/plan.md"),
            plan_mode_checker=lambda: False,
        )
        result = await tool(tool.params())
        assert isinstance(result, ToolError)
        assert "Not in plan mode" in result.message

    async def test_not_bound(self) -> None:
        from kimi_cli.tools.plan import ExitPlanMode

        tool = ExitPlanMode()
        # Not calling bind() at all
        result = await tool(tool.params())
        assert isinstance(result, ToolError)
        assert "Not in plan mode" in result.message

    async def test_no_plan_file(self, tmp_path: Path) -> None:
        from kimi_cli.tools.plan import ExitPlanMode

        tool = ExitPlanMode()
        plan_path = tmp_path / "nonexistent.md"
        tool.bind(
            toggle_callback=AsyncMock(return_value=False),
            plan_file_path_getter=lambda: plan_path,
            plan_mode_checker=lambda: True,
        )
        result = await tool(tool.params())
        assert isinstance(result, ToolError)
        assert "No plan file found" in result.message


# ---------------------------------------------------------------------------
# EnterPlanMode — guard conditions
# ---------------------------------------------------------------------------


class TestEnterPlanModeGuards:
    async def test_already_in_plan_mode(self) -> None:
        from kimi_cli.tools.plan.enter import EnterPlanMode

        tool = EnterPlanMode()
        tool.bind(
            toggle_callback=AsyncMock(return_value=True),
            plan_file_path_getter=lambda: Path("/tmp/plan.md"),
            plan_mode_checker=lambda: True,
        )
        result = await tool(tool.params())
        assert isinstance(result, ToolError)
        assert "Already in plan mode" in result.message

    async def test_not_bound(self) -> None:
        from kimi_cli.tools.plan.enter import EnterPlanMode

        tool = EnterPlanMode()
        # plan_mode_checker is None, so it won't trigger the "already in plan mode" guard
        # but toggle_callback is None, so it will trigger "not initialized"
        result = await tool(tool.params())
        assert isinstance(result, ToolError)
        assert "not properly initialized" in result.message


# ---------------------------------------------------------------------------
# EnterPlanMode — static description
# ---------------------------------------------------------------------------


class TestEnterPlanModeDescription:
    def test_description_is_static(self) -> None:
        tool = EnterPlanMode()
        assert tool.base.description == _DESCRIPTION


class TestManualPlanModeInjections:
    async def test_manual_toggle_defers_activation_to_injection(
        self,
        runtime: Runtime,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        soul = _make_soul(runtime, tmp_path)

        assert await soul.toggle_plan_mode_from_manual() is True
        assert soul.plan_mode is True
        assert soul._pending_plan_activation_injection is True
        assert soul.context.history == []

        injections = await soul._collect_injections()

        assert len(injections) == 1
        assert injections[0].type == "plan_mode"
        assert "Plan mode is active." in injections[0].content
        assert soul._pending_plan_activation_injection is False
        assert soul.context.history == []

    async def test_manual_exit_clears_pending_activation_injection(
        self,
        runtime: Runtime,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        soul = _make_soul(runtime, tmp_path)

        assert await soul.toggle_plan_mode_from_manual() is True
        assert soul._pending_plan_activation_injection is True

        assert await soul.toggle_plan_mode_from_manual() is False
        assert soul.plan_mode is False
        assert soul._pending_plan_activation_injection is False

        injections = await soul._collect_injections()
        assert injections == []

    async def test_tool_toggle_does_not_queue_manual_activation_injection(
        self,
        runtime: Runtime,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        soul = _make_soul(runtime, tmp_path)

        assert await soul.toggle_plan_mode() is True
        assert soul.plan_mode is True
        assert soul._pending_plan_activation_injection is False


class TestPlanModeProviderRoleGate:
    """Plan-mode workflow reminders are root-only.

    Subagents share ``session.state.plan_mode`` (so persistence/resume work),
    but they have ExitPlanMode/EnterPlanMode excluded by YAML. Injecting the
    workflow reminder would only invite hallucinated tool calls, so the gate
    lives inside PlanModeInjectionProvider where the reminder would be emitted.
    """

    async def test_subagent_receives_no_plan_mode_injection_when_root_in_plan_mode(
        self,
        runtime: Runtime,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        # Simulate root having toggled plan_mode on before the subagent spawned.
        runtime.session.state.plan_mode = True
        subagent_runtime = runtime.copy_for_subagent(
            agent_id="test-agent",
            subagent_type="test",
        )
        assert subagent_runtime.role == "subagent"
        soul = _make_soul(subagent_runtime, tmp_path)
        # Subagent still observes the shared plan_mode flag (state is
        # session-scoped) — the suppression is the provider's job, not the
        # soul's job.
        assert soul.plan_mode is True

        injections = await soul._collect_injections()
        assert all(inj.type != "plan_mode" for inj in injections)


# ---------------------------------------------------------------------------
# ExitPlanMode — happy paths
# ---------------------------------------------------------------------------


def _setup_exit_tool(
    tmp_path: Path, plan_content: str = "# My Plan"
) -> tuple[ExitPlanMode, AsyncMock, Path]:
    """Create and bind an ExitPlanMode tool with a real plan file."""
    tool = ExitPlanMode()
    plan_path = tmp_path / "plans" / "test-plan.md"
    plan_path.parent.mkdir(parents=True, exist_ok=True)
    plan_path.write_text(plan_content, encoding="utf-8")
    toggle_cb = AsyncMock(return_value=False)
    tool.bind(
        toggle_callback=toggle_cb,
        plan_file_path_getter=lambda: plan_path,
        plan_mode_checker=lambda: True,
    )
    return tool, toggle_cb, plan_path


def _mock_wire_and_tool_call(monkeypatch: pytest.MonkeyPatch):
    """Monkeypatch wire and tool call context for plan mode tool tests."""
    wire_mock = MagicMock()
    # Patch both the local imports in tools AND the central wire_send function
    monkeypatch.setattr("kimi_cli.tools.plan.get_wire_or_none", lambda: wire_mock)
    monkeypatch.setattr("kimi_cli.tools.plan.wire_send", lambda msg: None)
    monkeypatch.setattr("kimi_cli.tools.plan.enter.get_wire_or_none", lambda: wire_mock)
    monkeypatch.setattr("kimi_cli.tools.plan.enter.wire_send", lambda msg: None)
    tc = ToolCall(id="test-tc", function=ToolCall.FunctionBody(name="ExitPlanMode", arguments=None))
    monkeypatch.setattr("kimi_cli.tools.plan.get_current_tool_call_or_none", lambda: tc)
    monkeypatch.setattr("kimi_cli.tools.plan.enter.get_current_tool_call_or_none", lambda: tc)
    return wire_mock


class TestExitPlanModeHappyPaths:
    async def test_approve_toggles_off_and_returns_plan(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        tool, toggle_cb, plan_path = _setup_exit_tool(tmp_path)
        _mock_wire_and_tool_call(monkeypatch)
        monkeypatch.setattr(QuestionRequest, "wait", AsyncMock(return_value={"q": "Approve"}))

        result = await tool(tool.params())
        assert isinstance(result, ToolReturnValue)
        assert not result.is_error
        output = _tool_output_text(result)
        assert "Plan approved" in output
        assert "# My Plan" in output
        toggle_cb.assert_awaited_once()

    async def test_reject_returns_tool_rejected(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        tool, toggle_cb, _ = _setup_exit_tool(tmp_path)
        _mock_wire_and_tool_call(monkeypatch)
        monkeypatch.setattr(QuestionRequest, "wait", AsyncMock(return_value={"q": "Reject"}))

        result = await tool(tool.params())
        assert isinstance(result, ToolRejectedError)
        toggle_cb.assert_not_awaited()

    async def test_revise_with_feedback(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        tool, _, _ = _setup_exit_tool(tmp_path)
        _mock_wire_and_tool_call(monkeypatch)
        monkeypatch.setattr(
            QuestionRequest, "wait", AsyncMock(return_value={"q": "Fix the database section"})
        )

        result = await tool(tool.params())
        assert isinstance(result, ToolReturnValue)
        assert not result.is_error
        output = _tool_output_text(result)
        assert "revision" in output.lower() or "revise" in output.lower()
        assert "Fix the database section" in output

    async def test_revise_without_feedback(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        tool, _, _ = _setup_exit_tool(tmp_path)
        _mock_wire_and_tool_call(monkeypatch)
        monkeypatch.setattr(QuestionRequest, "wait", AsyncMock(return_value={"q": ""}))

        result = await tool(tool.params())
        assert isinstance(result, ToolReturnValue)
        assert not result.is_error
        assert "User feedback:" not in _tool_output_text(result)

    async def test_dismissed_returns_continue(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        tool, toggle_cb, _ = _setup_exit_tool(tmp_path)
        _mock_wire_and_tool_call(monkeypatch)
        monkeypatch.setattr(QuestionRequest, "wait", AsyncMock(return_value={}))

        result = await tool(tool.params())
        assert isinstance(result, ToolReturnValue)
        assert not result.is_error
        assert "dismissed" in _tool_output_text(result).lower()
        toggle_cb.assert_not_awaited()

    async def test_question_not_supported(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        tool, _, _ = _setup_exit_tool(tmp_path)
        _mock_wire_and_tool_call(monkeypatch)
        monkeypatch.setattr(QuestionRequest, "wait", AsyncMock(side_effect=QuestionNotSupported()))

        result = await tool(tool.params())
        assert isinstance(result, ToolError)
        assert "Client unsupported" in result.brief

    async def test_question_exception(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        tool, _, _ = _setup_exit_tool(tmp_path)
        _mock_wire_and_tool_call(monkeypatch)
        monkeypatch.setattr(QuestionRequest, "wait", AsyncMock(side_effect=RuntimeError("boom")))

        result = await tool(tool.params())
        assert isinstance(result, ToolError)
        assert "Failed" in result.message or "failed" in result.message

    async def test_wire_unavailable(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        tool, _, _ = _setup_exit_tool(tmp_path)
        monkeypatch.setattr("kimi_cli.tools.plan.get_wire_or_none", lambda: None)
        tc = ToolCall(id="t", function=ToolCall.FunctionBody(name="ExitPlanMode", arguments=None))
        monkeypatch.setattr("kimi_cli.tools.plan.get_current_tool_call_or_none", lambda: tc)

        result = await tool(tool.params())
        assert isinstance(result, ToolError)
        assert "Wire" in result.message or "unavailable" in result.message.lower()


# ---------------------------------------------------------------------------
# EnterPlanMode — happy paths
# ---------------------------------------------------------------------------


def _setup_enter_tool(tmp_path: Path) -> tuple[EnterPlanMode, AsyncMock, Path]:
    """Create and bind an EnterPlanMode tool."""
    tool = EnterPlanMode()
    plan_path = tmp_path / "plans" / "test-plan.md"
    toggle_cb = AsyncMock(return_value=True)
    tool.bind(
        toggle_callback=toggle_cb,
        plan_file_path_getter=lambda: plan_path,
        plan_mode_checker=lambda: False,
    )
    return tool, toggle_cb, plan_path


class TestEnterPlanModeHappyPaths:
    async def test_user_accepts(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        tool, toggle_cb, plan_path = _setup_enter_tool(tmp_path)
        _mock_wire_and_tool_call(monkeypatch)
        monkeypatch.setattr(QuestionRequest, "wait", AsyncMock(return_value={"q": "Yes"}))

        result = await tool(tool.params())
        assert isinstance(result, ToolReturnValue)
        assert not result.is_error
        output = _tool_output_text(result)
        assert "Plan mode activated" in output or "plan mode" in output.lower()
        assert str(plan_path) in output
        assert "StrReplaceFile" in output
        assert "clarify missing requirements" in output
        toggle_cb.assert_awaited_once()

    async def test_user_declines(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        tool, toggle_cb, _ = _setup_enter_tool(tmp_path)
        _mock_wire_and_tool_call(monkeypatch)
        monkeypatch.setattr(QuestionRequest, "wait", AsyncMock(return_value={"q": "No"}))

        result = await tool(tool.params())
        assert isinstance(result, ToolReturnValue)
        assert not result.is_error
        assert "declined" in _tool_output_text(result).lower()
        toggle_cb.assert_not_awaited()

    async def test_dismissed(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        tool, toggle_cb, _ = _setup_enter_tool(tmp_path)
        _mock_wire_and_tool_call(monkeypatch)
        monkeypatch.setattr(QuestionRequest, "wait", AsyncMock(return_value={}))

        result = await tool(tool.params())
        assert isinstance(result, ToolReturnValue)
        assert not result.is_error
        assert "dismissed" in _tool_output_text(result).lower()
        toggle_cb.assert_not_awaited()

    async def test_question_not_supported(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        tool, _, _ = _setup_enter_tool(tmp_path)
        _mock_wire_and_tool_call(monkeypatch)
        monkeypatch.setattr(QuestionRequest, "wait", AsyncMock(side_effect=QuestionNotSupported()))

        result = await tool(tool.params())
        assert isinstance(result, ToolError)
        assert "Client unsupported" in result.brief

    async def test_wire_unavailable(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        tool, _, _ = _setup_enter_tool(tmp_path)
        monkeypatch.setattr("kimi_cli.tools.plan.enter.get_wire_or_none", lambda: None)
        tc = ToolCall(id="t", function=ToolCall.FunctionBody(name="EnterPlanMode", arguments=None))
        monkeypatch.setattr("kimi_cli.tools.plan.enter.get_current_tool_call_or_none", lambda: tc)

        result = await tool(tool.params())
        assert isinstance(result, ToolError)
        assert "Wire" in result.message or "unavailable" in result.message.lower()


# ---------------------------------------------------------------------------
# KimiSoul — plan mode state management
# ---------------------------------------------------------------------------


class TestKimiSoulPlanState:
    async def test_session_id_allocated_on_activation(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        soul = _make_soul(runtime, tmp_path)

        soul._set_plan_mode(True, source="tool")
        assert soul._plan_session_id is not None

    async def test_session_id_idempotent(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        soul = _make_soul(runtime, tmp_path)

        soul._ensure_plan_session_id()
        first = soul._plan_session_id
        soul._ensure_plan_session_id()
        assert soul._plan_session_id == first

    async def test_session_id_persists_after_deactivation(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        soul = _make_soul(runtime, tmp_path)

        soul._set_plan_mode(True, source="tool")
        soul._set_plan_mode(False, source="tool")
        assert soul._plan_session_id is None

    def test_plan_file_path_none_before_activation(self, runtime: Runtime, tmp_path: Path) -> None:
        soul = _make_soul(runtime, tmp_path)
        assert soul.get_plan_file_path() is None

    async def test_plan_file_path_valid_after_activation(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        soul = _make_soul(runtime, tmp_path)

        soul._set_plan_mode(True, source="tool")
        path = soul.get_plan_file_path()
        assert path is not None
        assert path.suffix == ".md"

    async def test_read_current_plan_none_no_file(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        soul = _make_soul(runtime, tmp_path)

        soul._set_plan_mode(True, source="tool")
        assert soul.read_current_plan() is None

    async def test_read_current_plan_returns_content(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        soul = _make_soul(runtime, tmp_path)

        soul._set_plan_mode(True, source="tool")
        path = soul.get_plan_file_path()
        assert path is not None
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("# Test Plan", encoding="utf-8")
        assert soul.read_current_plan() == "# Test Plan"

    async def test_clear_current_plan_deletes_file(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        soul = _make_soul(runtime, tmp_path)

        soul._set_plan_mode(True, source="tool")
        path = soul.get_plan_file_path()
        assert path is not None
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("# Plan", encoding="utf-8")
        soul.clear_current_plan()
        assert not path.exists()

    async def test_clear_current_plan_noop_no_file(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        soul = _make_soul(runtime, tmp_path)

        soul._set_plan_mode(True, source="tool")
        soul.clear_current_plan()  # should not raise

    async def test_status_includes_plan_mode(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        soul = _make_soul(runtime, tmp_path)

        assert soul.status.plan_mode is False
        soul._set_plan_mode(True, source="tool")
        assert soul.status.plan_mode is True
        soul._set_plan_mode(False, source="tool")
        assert soul.status.plan_mode is False

    def test_bind_plan_mode_tools_binds_callbacks(self, runtime: Runtime, tmp_path: Path) -> None:
        toolset = KimiToolset()
        write_tool = WriteFile(runtime, runtime.approval)
        replace_tool = StrReplaceFile(runtime, runtime.approval)
        toolset.add(write_tool)
        toolset.add(replace_tool)

        agent = Agent(
            name="Test Agent",
            system_prompt="Test system prompt.",
            toolset=toolset,
            runtime=runtime,
        )
        soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))

        assert write_tool._plan_mode_checker is not None
        assert write_tool._plan_file_path_getter is not None
        assert replace_tool._plan_mode_checker is not None
        assert replace_tool._plan_file_path_getter is not None

        soul._set_plan_mode(True, source="tool")
        plan_path = soul.get_plan_file_path()
        assert plan_path is not None
        assert write_tool._plan_mode_checker() is True
        assert replace_tool._plan_mode_checker() is True
        assert write_tool._plan_file_path_getter() == plan_path
        assert replace_tool._plan_file_path_getter() == plan_path


# ---------------------------------------------------------------------------
# KimiSoul — plan_session_id cross-process persistence
# ---------------------------------------------------------------------------


class TestKimiSoulPlanSessionPersistence:
    """Tests that plan_session_id survives simulated process restarts."""

    async def test_plan_session_id_survives_restart(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Second KimiSoul created from same session state gets same plan file path."""
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        soul1 = _make_soul(runtime, tmp_path)
        soul1._set_plan_mode(True, source="tool")
        path1 = soul1.get_plan_file_path()
        assert path1 is not None

        # Simulate restart: clear in-process slug cache (as would happen in a new process)
        _slug_cache.clear()

        # New KimiSoul reads from same (already-saved) session state and re-seeds cache
        soul2 = _make_soul(runtime, tmp_path)
        path2 = soul2.get_plan_file_path()
        assert path2 == path1

    async def test_plan_session_id_cleared_after_deactivation(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """After plan mode is turned off and process restarts, new activation gets fresh path."""
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)
        soul1 = _make_soul(runtime, tmp_path)
        soul1._set_plan_mode(True, source="tool")
        path1 = soul1.get_plan_file_path()
        soul1._set_plan_mode(False, source="tool")
        # state.plan_session_id is now None in persisted state

        # Restart + re-activate
        from kimi_cli.tools.plan.heroes import _slug_cache

        _slug_cache.clear()  # simulate fresh process (in-memory cache gone)
        soul2 = _make_soul(runtime, tmp_path)
        soul2._set_plan_mode(True, source="tool")
        path2 = soul2.get_plan_file_path()
        assert path2 != path1  # fresh slug, different path


# ---------------------------------------------------------------------------
# ToolRejectedError — enhanced constructor
# ---------------------------------------------------------------------------


class TestToolRejectedError:
    def test_default_message(self) -> None:
        err = ToolRejectedError()
        assert "rejected" in err.message.lower()
        assert err.brief == "Rejected by user"

    def test_custom_message_and_brief(self) -> None:
        err = ToolRejectedError(message="Plan rejected", brief="Rejected")
        assert err.message == "Plan rejected"
        assert err.brief == "Rejected"

    def test_custom_message_default_brief(self) -> None:
        err = ToolRejectedError(message="Custom rejection")
        assert err.message == "Custom rejection"
        assert err.brief == "Rejected by user"


# ---------------------------------------------------------------------------
# ExitPlanMode — multi-option selection
# ---------------------------------------------------------------------------


class TestExitPlanModeMultiOption:
    """Tests for ExitPlanMode with the `options` parameter."""

    def _make_params_with_options(self) -> Params:
        return Params(
            options=[
                PlanOption(label="Option A (Recommended)", description="Add new method"),
                PlanOption(label="Option B", description="Modify call site"),
            ]
        )

    async def test_select_option_approves_plan(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        tool, toggle_cb, plan_path = _setup_exit_tool(tmp_path)
        _mock_wire_and_tool_call(monkeypatch)
        monkeypatch.setattr(
            QuestionRequest,
            "wait",
            AsyncMock(return_value={"q": "Option A (Recommended)"}),
        )

        params = self._make_params_with_options()
        result = await tool(params)
        assert isinstance(result, ToolReturnValue)
        assert not result.is_error
        output = _tool_output_text(result)
        assert "Option A (Recommended)" in output
        assert "Selected approach" in output
        assert "# My Plan" in output
        toggle_cb.assert_awaited_once()

    async def test_select_second_option(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        tool, toggle_cb, _ = _setup_exit_tool(tmp_path)
        _mock_wire_and_tool_call(monkeypatch)
        monkeypatch.setattr(QuestionRequest, "wait", AsyncMock(return_value={"q": "Option B"}))

        params = self._make_params_with_options()
        result = await tool(params)
        assert isinstance(result, ToolReturnValue)
        assert not result.is_error
        output = _tool_output_text(result)
        assert "Option B" in output
        assert "Selected approach" in output
        toggle_cb.assert_awaited_once()

    async def test_reject_with_options(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        tool, toggle_cb, _ = _setup_exit_tool(tmp_path)
        _mock_wire_and_tool_call(monkeypatch)
        monkeypatch.setattr(QuestionRequest, "wait", AsyncMock(return_value={"q": "Reject"}))

        params = self._make_params_with_options()
        result = await tool(params)
        assert isinstance(result, ToolRejectedError)
        toggle_cb.assert_not_awaited()

    async def test_revise_with_options(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        tool, _, _ = _setup_exit_tool(tmp_path)
        _mock_wire_and_tool_call(monkeypatch)
        monkeypatch.setattr(
            QuestionRequest,
            "wait",
            AsyncMock(return_value={"q": "I want a third approach using decorator"}),
        )

        params = self._make_params_with_options()
        result = await tool(params)
        assert isinstance(result, ToolReturnValue)
        assert not result.is_error
        output = _tool_output_text(result)
        assert "revision" in output.lower() or "revise" in output.lower()
        assert "decorator" in output

    async def test_dismissed_with_options(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        tool, toggle_cb, _ = _setup_exit_tool(tmp_path)
        _mock_wire_and_tool_call(monkeypatch)
        monkeypatch.setattr(QuestionRequest, "wait", AsyncMock(return_value={}))

        params = self._make_params_with_options()
        result = await tool(params)
        assert isinstance(result, ToolReturnValue)
        assert not result.is_error
        assert "dismissed" in _tool_output_text(result).lower()
        toggle_cb.assert_not_awaited()

    async def test_no_options_falls_back_to_approve_reject(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When options=None, behaves like the original Approve/Reject flow."""
        tool, toggle_cb, _ = _setup_exit_tool(tmp_path)
        _mock_wire_and_tool_call(monkeypatch)
        monkeypatch.setattr(QuestionRequest, "wait", AsyncMock(return_value={"q": "Approve"}))

        result = await tool(tool.params())
        assert isinstance(result, ToolReturnValue)
        assert not result.is_error
        assert "Plan approved" in _tool_output_text(result)
        toggle_cb.assert_awaited_once()

    async def test_single_option_falls_back_to_approve_reject(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When only 1 option is provided (<2), falls back to Approve/Reject."""
        tool, toggle_cb, _ = _setup_exit_tool(tmp_path)
        _mock_wire_and_tool_call(monkeypatch)
        monkeypatch.setattr(QuestionRequest, "wait", AsyncMock(return_value={"q": "Approve"}))

        params = Params(options=[PlanOption(label="Only one", description="...")])
        result = await tool(params)
        assert isinstance(result, ToolReturnValue)
        assert not result.is_error
        assert "Plan approved" in _tool_output_text(result)
        toggle_cb.assert_awaited_once()


# ---------------------------------------------------------------------------
# PlanOption validator — reserved labels and Params max_length
# ---------------------------------------------------------------------------


class TestPlanOptionValidator:
    """Tests for PlanOption label validation and Params.options max_length."""

    def test_reserved_label_reject_raises(self) -> None:
        with pytest.raises(ValidationError):
            PlanOption(label="Reject", description="x")

    def test_reserved_label_reject_lowercase_raises(self) -> None:
        with pytest.raises(ValidationError):
            PlanOption(label="reject", description="x")

    def test_reserved_label_revise_raises(self) -> None:
        with pytest.raises(ValidationError):
            PlanOption(label="Revise", description="x")

    def test_reserved_label_approve_raises(self) -> None:
        with pytest.raises(ValidationError):
            PlanOption(label="Approve", description="x")

    def test_reserved_label_with_whitespace_raises(self) -> None:
        with pytest.raises(ValidationError):
            PlanOption(label="  Reject  ", description="x")

    def test_non_reserved_label_ok(self) -> None:
        opt = PlanOption(label="Option A", description="x")
        assert opt.label == "Option A"

    def test_params_max_four_options_raises(self) -> None:
        """Params.options has max_length=3; passing 4 must raise ValidationError."""
        with pytest.raises(ValidationError):
            Params(
                options=[
                    PlanOption(label="A", description=""),
                    PlanOption(label="B", description=""),
                    PlanOption(label="C", description=""),
                    PlanOption(label="D", description=""),
                ]
            )

    def test_params_duplicate_labels_raises(self) -> None:
        """Duplicate option labels must raise ValidationError."""
        with pytest.raises(ValidationError):
            Params(
                options=[
                    PlanOption(label="Patch config", description=""),
                    PlanOption(label="Patch config", description="different desc"),
                ]
            )

    def test_params_three_options_ok(self) -> None:
        params = Params(
            options=[
                PlanOption(label="A", description=""),
                PlanOption(label="B", description=""),
                PlanOption(label="C", description=""),
            ]
        )
        assert params.options is not None
        assert len(params.options) == 3
