"""Tests for --plan flag and default_plan_mode config in KimiCLI.create()."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest

import kimi_cli.app as app_module
from kimi_cli.app import KimiCLI

# ---------------------------------------------------------------------------
# Helpers — lightweight fakes for KimiCLI.create() dependencies
# ---------------------------------------------------------------------------


def _patch_create_deps(monkeypatch, *, session_plan_mode: bool = False):
    """Patch heavy dependencies so KimiCLI.create() runs without I/O.

    Returns a FakeSoul class whose instances record plan-mode interactions.
    """

    class FakeSoul:
        """Tracks plan-mode calls made by KimiCLI.create()."""

        instances: list[FakeSoul] = []

        def __init__(self, agent, context):
            self.plan_mode = session_plan_mode
            self._set_plan_mode_calls: list[tuple[bool, str]] = []
            self._schedule_reminder_called = False
            FakeSoul.instances.append(self)

        async def set_plan_mode_from_manual(self, enabled: bool) -> bool:
            self._set_plan_mode_calls.append((enabled, "manual"))
            self.plan_mode = enabled
            return enabled

        def schedule_plan_activation_reminder(self) -> None:
            self._schedule_reminder_called = True

        def set_hook_engine(self, engine):
            pass

    # Reset class-level tracker
    FakeSoul.instances = []

    fake_context = SimpleNamespace(system_prompt=None)
    fake_context.restore = AsyncMock()
    fake_context.write_system_prompt = AsyncMock()

    runtime_create_calls: list[dict] = []

    async def fake_runtime_create(config, _oauth, _llm, session, yolo, **kwargs):
        runtime_create_calls.append({"yolo": yolo})
        return SimpleNamespace(
            session=session,
            config=config,
            llm=None,
            notifications=SimpleNamespace(recover=lambda: None),
            background_tasks=SimpleNamespace(reconcile=lambda: None),
        )

    monkeypatch.setattr(app_module, "load_config", lambda conf: conf)
    monkeypatch.setattr(app_module, "augment_provider_with_env_vars", lambda p, m: {})
    monkeypatch.setattr(app_module, "create_llm", lambda *a, **kw: None)
    monkeypatch.setattr(app_module.Runtime, "create", fake_runtime_create)
    monkeypatch.setattr(
        app_module,
        "load_agent",
        AsyncMock(return_value=SimpleNamespace(name="test", system_prompt="sp")),
    )
    monkeypatch.setattr(app_module, "Context", lambda _path: fake_context)
    monkeypatch.setattr(app_module, "KimiSoul", FakeSoul)

    return FakeSoul, runtime_create_calls


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestPlanFlagNewSession:
    """New sessions (resumed=False)."""

    @pytest.mark.asyncio
    async def test_plan_flag_activates_plan_mode(self, session, config, monkeypatch):
        """--plan flag on a new session should call set_plan_mode_from_manual(True)."""
        FakeSoul, _ = _patch_create_deps(monkeypatch)

        await KimiCLI.create(session, config=config, plan_mode=True, resumed=False)

        soul = FakeSoul.instances[0]
        assert soul._set_plan_mode_calls == [(True, "manual")]
        assert not soul._schedule_reminder_called

    @pytest.mark.asyncio
    async def test_config_default_plan_mode_activates(self, session, config, monkeypatch):
        """default_plan_mode=True in config should activate plan mode for new sessions."""
        config.default_plan_mode = True
        FakeSoul, _ = _patch_create_deps(monkeypatch)

        await KimiCLI.create(session, config=config, plan_mode=False, resumed=False)

        soul = FakeSoul.instances[0]
        assert soul._set_plan_mode_calls == [(True, "manual")]

    @pytest.mark.asyncio
    async def test_no_plan_flag_no_config_stays_inactive(self, session, config, monkeypatch):
        """Without --plan or config, plan mode stays inactive."""
        FakeSoul, _ = _patch_create_deps(monkeypatch)

        await KimiCLI.create(session, config=config, plan_mode=False, resumed=False)

        soul = FakeSoul.instances[0]
        assert soul._set_plan_mode_calls == []
        assert not soul._schedule_reminder_called

    @pytest.mark.asyncio
    async def test_plan_flag_overrides_config_false(self, session, config, monkeypatch):
        """--plan flag should activate plan mode even when config is False."""
        config.default_plan_mode = False
        FakeSoul, _ = _patch_create_deps(monkeypatch)

        await KimiCLI.create(session, config=config, plan_mode=True, resumed=False)

        soul = FakeSoul.instances[0]
        assert soul._set_plan_mode_calls == [(True, "manual")]


class TestPlanFlagResumedSession:
    """Resumed sessions (resumed=True)."""

    @pytest.mark.asyncio
    async def test_config_not_applied_on_resumed_session(self, session, config, monkeypatch):
        """config.default_plan_mode should NOT be applied when resuming a session."""
        config.default_plan_mode = True
        FakeSoul, _ = _patch_create_deps(monkeypatch)

        await KimiCLI.create(session, config=config, plan_mode=False, resumed=True)

        soul = FakeSoul.instances[0]
        # plan_mode param stays False because resumed=True skips config
        assert soul._set_plan_mode_calls == []
        assert not soul._schedule_reminder_called

    @pytest.mark.asyncio
    async def test_plan_flag_activates_on_resumed_session_without_plan(
        self, session, config, monkeypatch
    ):
        """--plan on a resumed session that was NOT in plan mode should activate it."""
        FakeSoul, _ = _patch_create_deps(monkeypatch, session_plan_mode=False)

        await KimiCLI.create(session, config=config, plan_mode=True, resumed=True)

        soul = FakeSoul.instances[0]
        assert soul._set_plan_mode_calls == [(True, "manual")]
        assert not soul._schedule_reminder_called

    @pytest.mark.asyncio
    async def test_plan_flag_on_already_plan_session_triggers_reminder(
        self, session, config, monkeypatch
    ):
        """--plan on a resumed session already in plan mode should schedule a reminder."""
        FakeSoul, _ = _patch_create_deps(monkeypatch, session_plan_mode=True)

        await KimiCLI.create(session, config=config, plan_mode=True, resumed=True)

        soul = FakeSoul.instances[0]
        # Should NOT call set_plan_mode since already active
        assert soul._set_plan_mode_calls == []
        assert soul._schedule_reminder_called

    @pytest.mark.asyncio
    async def test_resumed_session_preserves_existing_plan_mode(self, session, config, monkeypatch):
        """Resumed session with plan_mode already active (no --plan flag) stays in plan mode."""
        FakeSoul, _ = _patch_create_deps(monkeypatch, session_plan_mode=True)

        await KimiCLI.create(session, config=config, plan_mode=False, resumed=True)

        soul = FakeSoul.instances[0]
        assert soul._set_plan_mode_calls == []
        assert not soul._schedule_reminder_called
        # plan_mode is still True from session state
        assert soul.plan_mode is True


class TestPlanFlagPriority:
    """CLI flag > config > default."""

    @pytest.mark.asyncio
    async def test_flag_true_beats_config_false(self, session, config, monkeypatch):
        """--plan should win over default_plan_mode=False."""
        config.default_plan_mode = False
        FakeSoul, _ = _patch_create_deps(monkeypatch)

        await KimiCLI.create(session, config=config, plan_mode=True, resumed=False)

        soul = FakeSoul.instances[0]
        assert soul._set_plan_mode_calls == [(True, "manual")]

    @pytest.mark.asyncio
    async def test_config_true_with_no_flag(self, session, config, monkeypatch):
        """default_plan_mode=True should activate when no --plan flag is given."""
        config.default_plan_mode = True
        FakeSoul, _ = _patch_create_deps(monkeypatch)

        await KimiCLI.create(session, config=config, plan_mode=False, resumed=False)

        soul = FakeSoul.instances[0]
        assert soul._set_plan_mode_calls == [(True, "manual")]

    @pytest.mark.asyncio
    async def test_default_is_false(self, session, config, monkeypatch):
        """Default state: no flag, no config → plan mode inactive."""
        assert config.default_plan_mode is False
        FakeSoul, _ = _patch_create_deps(monkeypatch)

        await KimiCLI.create(session, config=config, resumed=False)

        soul = FakeSoul.instances[0]
        assert soul._set_plan_mode_calls == []

    @pytest.mark.asyncio
    async def test_plan_and_yolo_coexist(self, session, config, monkeypatch):
        """--plan and --yolo can be used together without conflict."""
        FakeSoul, runtime_create_calls = _patch_create_deps(monkeypatch)

        await KimiCLI.create(session, config=config, plan_mode=True, yolo=True, resumed=False)

        soul = FakeSoul.instances[0]
        assert soul._set_plan_mode_calls == [(True, "manual")]
        assert runtime_create_calls[0]["yolo"] is True


class TestSchedulePlanActivationReminder:
    """Unit tests for KimiSoul.schedule_plan_activation_reminder()."""

    def test_schedules_when_in_plan_mode(self, runtime, tmp_path, monkeypatch):
        """Reminder is scheduled when plan mode is active."""
        from kosong.tooling.empty import EmptyToolset

        from kimi_cli.soul.agent import Agent
        from kimi_cli.soul.context import Context
        from kimi_cli.soul.kimisoul import KimiSoul

        # Redirect PLANS_DIR to tmp_path to avoid filesystem side effects
        monkeypatch.setattr("kimi_cli.tools.plan.heroes.PLANS_DIR", tmp_path)

        agent = Agent(
            name="Test",
            system_prompt="Test",
            toolset=EmptyToolset(),
            runtime=runtime,
        )
        soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "ctx.jsonl"))

        # Enable plan mode first
        soul._set_plan_mode(True, source="manual")
        # Reset the pending flag set by _set_plan_mode
        soul._pending_plan_activation_injection = False

        # Now test schedule_plan_activation_reminder
        soul.schedule_plan_activation_reminder()
        assert soul._pending_plan_activation_injection is True

    def test_noop_when_not_in_plan_mode(self, runtime, tmp_path):
        """Reminder is NOT scheduled when plan mode is inactive."""
        from kosong.tooling.empty import EmptyToolset

        from kimi_cli.soul.agent import Agent
        from kimi_cli.soul.context import Context
        from kimi_cli.soul.kimisoul import KimiSoul

        agent = Agent(
            name="Test",
            system_prompt="Test",
            toolset=EmptyToolset(),
            runtime=runtime,
        )
        soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "ctx.jsonl"))

        assert soul.plan_mode is False
        soul.schedule_plan_activation_reminder()
        assert soul._pending_plan_activation_injection is False


class TestWebWorkerResumedDetection:
    """Verify web worker derives `resumed` from session state on disk."""

    @pytest.mark.asyncio
    async def test_new_session_without_state_file_is_not_resumed(self, tmp_path):
        """A brand-new web session (no state.json) should pass resumed=False."""
        from kimi_cli.web.runner.worker import run_worker

        session_dir = tmp_path / "session-dir"
        session_dir.mkdir()
        # No state.json → new session

        create_calls: list[dict] = []

        class _StopWorker(Exception):
            pass

        async def spy_create(session, **kwargs):
            create_calls.append(kwargs)
            raise _StopWorker  # abort after capturing args

        fake_session = SimpleNamespace(dir=session_dir)
        fake_joint = SimpleNamespace(kimi_cli_session=fake_session)

        with (
            patch("kimi_cli.web.runner.worker.load_session_by_id", return_value=fake_joint),
            patch(
                "kimi_cli.web.runner.worker.get_global_mcp_config_file",
                return_value=tmp_path / "no-mcp.json",
            ),
            patch.object(KimiCLI, "create", side_effect=spy_create),
            pytest.raises(_StopWorker),
        ):
            await run_worker(uuid4())

        assert create_calls[0]["resumed"] is False

    @pytest.mark.asyncio
    async def test_existing_session_with_state_file_is_resumed(self, tmp_path):
        """A session with state.json on disk should pass resumed=True."""
        from kimi_cli.web.runner.worker import run_worker

        session_dir = tmp_path / "session-dir"
        session_dir.mkdir()
        (session_dir / "state.json").write_text("{}", encoding="utf-8")

        create_calls: list[dict] = []

        class _StopWorker(Exception):
            pass

        async def spy_create(session, **kwargs):
            create_calls.append(kwargs)
            raise _StopWorker

        fake_session = SimpleNamespace(dir=session_dir)
        fake_joint = SimpleNamespace(kimi_cli_session=fake_session)

        with (
            patch("kimi_cli.web.runner.worker.load_session_by_id", return_value=fake_joint),
            patch(
                "kimi_cli.web.runner.worker.get_global_mcp_config_file",
                return_value=tmp_path / "no-mcp.json",
            ),
            patch.object(KimiCLI, "create", side_effect=spy_create),
            pytest.raises(_StopWorker),
        ):
            await run_worker(uuid4())

        assert create_calls[0]["resumed"] is True
