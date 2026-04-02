# pyright: reportOptionalMemberAccess=false
from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from kosong.tooling.empty import EmptyToolset

from kimi_cli.approval_runtime import ApprovalSource
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.subagents import AgentLaunchSpec
from kimi_cli.tools.display import ShellDisplayBlock
from kimi_cli.ui.shell import Shell
from kimi_cli.ui.shell import slash as shell_slash
from kimi_cli.wire.types import ApprovalRequest


class _FakePlaceholderManager:
    """Minimal placeholder manager stub — serialize_for_history is identity."""

    @staticmethod
    def serialize_for_history(text: str) -> str:
        return text


def _make_shell_app(runtime: Runtime, tmp_path: Path) -> SimpleNamespace:
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    return SimpleNamespace(soul=soul)


def test_task_command_registered_in_shell_registries() -> None:
    assert shell_slash.registry.find_command("task") is not None
    assert shell_slash.shell_mode_registry.find_command("task") is not None


@pytest.mark.asyncio
async def test_task_command_rejects_args(runtime: Runtime, tmp_path: Path, monkeypatch) -> None:
    app = _make_shell_app(runtime, tmp_path)
    print_mock = Mock()
    monkeypatch.setattr(shell_slash.console, "print", print_mock)

    await shell_slash.task(app, "unexpected")  # type: ignore[arg-type]

    print_mock.assert_called_once()
    assert 'Usage: "/task"' in str(print_mock.call_args.args[0])


@pytest.mark.asyncio
async def test_task_command_requires_root_role(
    runtime: Runtime, tmp_path: Path, monkeypatch
) -> None:
    runtime.role = "subagent"
    app = _make_shell_app(runtime, tmp_path)
    print_mock = Mock()
    monkeypatch.setattr(shell_slash.console, "print", print_mock)

    await shell_slash.task(app, "")  # type: ignore[arg-type]

    print_mock.assert_called_once()
    assert "root agent" in str(print_mock.call_args.args[0])


@pytest.mark.asyncio
async def test_task_command_launches_browser(runtime: Runtime, tmp_path: Path, monkeypatch) -> None:
    app = _make_shell_app(runtime, tmp_path)
    run_mock = Mock()

    class _FakeTaskBrowserApp:
        def __init__(self, soul: KimiSoul):
            assert soul is app.soul

        async def run(self) -> None:
            run_mock()

    monkeypatch.setattr(shell_slash, "TaskBrowserApp", _FakeTaskBrowserApp)

    await shell_slash.task(app, "")  # type: ignore[arg-type]

    run_mock.assert_called_once()


class TestShellBackgroundTaskCleanup:
    """Verify that Shell cancels background tasks (notification watcher, etc.) on exit."""

    def _make_shell(self, runtime: Runtime, tmp_path: Path) -> Shell:
        agent = Agent(
            name="Test Agent",
            system_prompt="Test system prompt.",
            toolset=EmptyToolset(),
            runtime=runtime,
        )
        soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
        return Shell(soul)

    @pytest.mark.asyncio
    async def test_cancel_background_tasks_cancels_all_tasks(
        self, runtime: Runtime, tmp_path: Path
    ) -> None:
        shell = self._make_shell(runtime, tmp_path)

        async def _forever() -> None:
            await asyncio.Event().wait()

        task1 = shell._start_background_task(_forever())
        task2 = shell._start_background_task(_forever())
        assert not task1.done()
        assert not task2.done()

        shell._cancel_background_tasks()

        # Yield control so cancellation propagates
        await asyncio.sleep(0)

        assert task1.cancelled()
        assert task2.cancelled()
        assert len(shell._background_tasks) == 0

    @pytest.mark.asyncio
    async def test_cancel_background_tasks_is_idempotent(
        self, runtime: Runtime, tmp_path: Path
    ) -> None:
        shell = self._make_shell(runtime, tmp_path)

        async def _forever() -> None:
            await asyncio.Event().wait()

        shell._start_background_task(_forever())
        shell._cancel_background_tasks()
        await asyncio.sleep(0)
        shell._cancel_background_tasks()  # second call should not raise

        assert len(shell._background_tasks) == 0


@pytest.mark.asyncio
async def test_shell_handles_background_approval_without_active_turn(
    runtime: Runtime,
    tmp_path: Path,
) -> None:
    """Without prompt_session or sink, approval requests are queued."""
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    shell = Shell(soul)

    runtime.approval_runtime.create_request(
        request_id="req-bg-1",
        tool_call_id="call-1",
        sender="Shell",
        action="run command",
        description="pwd",
        display=[],
        source=ApprovalSource(
            kind="background_agent",
            id="task-1",
            agent_id="a1234567",
            subagent_type="coder",
        ),
    )

    request = ApprovalRequest(
        id="req-bg-1",
        tool_call_id="call-1",
        sender="Shell",
        action="run command",
        description="pwd",
        source_kind="background_agent",
        source_id="task-1",
        agent_id="a1234567",
        subagent_type="coder",
    )

    await shell._handle_root_hub_message(request)  # type: ignore[attr-defined]
    assert list(shell._pending_approval_requests) == [request]  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_shell_background_approval_with_prompt_session_uses_prompt_modal(
    runtime: Runtime, tmp_path: Path, monkeypatch
) -> None:
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    shell = Shell(soul)

    runtime.approval_runtime.create_request(
        request_id="req-bg-modal-1",
        tool_call_id="call-bg-modal-1",
        sender="Shell",
        action="run command",
        description="pwd",
        display=[],
        source=ApprovalSource(
            kind="background_agent",
            id="task-modal-1",
            agent_id="a1234567",
            subagent_type="coder",
        ),
    )

    attached: list[object] = []
    invalidations: list[str] = []

    class _PromptSession:
        def attach_modal(self, delegate) -> None:
            attached.append(delegate)

        def detach_modal(self, delegate) -> None:
            return None

        def invalidate(self) -> None:
            invalidations.append("invalidate")

        def _get_placeholder_manager(self) -> _FakePlaceholderManager:
            return _FakePlaceholderManager()

    shell._prompt_session = _PromptSession()  # type: ignore[attr-defined]

    request = ApprovalRequest(
        id="req-bg-modal-1",
        tool_call_id="call-bg-modal-1",
        sender="Shell",
        action="run command",
        description="pwd",
        source_kind="background_agent",
        source_id="task-modal-1",
        agent_id="a1234567",
        subagent_type="coder",
    )

    await shell._handle_root_hub_message(request)  # type: ignore[attr-defined]

    assert shell._approval_modal is not None  # type: ignore[attr-defined]
    assert attached == [shell._approval_modal]  # type: ignore[attr-defined]
    assert invalidations


@pytest.mark.asyncio
async def test_shell_prompt_approval_modal_keeps_current_request_when_new_request_arrives(
    runtime: Runtime, tmp_path: Path
) -> None:
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    shell = Shell(soul)

    runtime.approval_runtime.create_request(
        request_id="req-approval-1",
        tool_call_id="call-approval-1",
        sender="Shell",
        action="run command",
        description="pwd",
        display=[],
        source=ApprovalSource(kind="background_agent", id="task-approval-1"),
    )
    runtime.approval_runtime.create_request(
        request_id="req-approval-2",
        tool_call_id="call-approval-2",
        sender="Shell",
        action="run command",
        description="ls",
        display=[],
        source=ApprovalSource(kind="background_agent", id="task-approval-2"),
    )

    attached: list[object] = []

    class _PromptSession:
        def attach_modal(self, delegate) -> None:
            attached.append(delegate)

        def detach_modal(self, delegate) -> None:
            return None

        def invalidate(self) -> None:
            return None

        def _get_placeholder_manager(self) -> _FakePlaceholderManager:
            return _FakePlaceholderManager()

    shell._prompt_session = _PromptSession()  # type: ignore[attr-defined]

    request_one = ApprovalRequest(
        id="req-approval-1",
        tool_call_id="call-approval-1",
        sender="Shell",
        action="run command",
        description="pwd",
        source_kind="background_agent",
        source_id="task-approval-1",
    )
    request_two = ApprovalRequest(
        id="req-approval-2",
        tool_call_id="call-approval-2",
        sender="Shell",
        action="run command",
        description="ls",
        source_kind="background_agent",
        source_id="task-approval-2",
    )

    await shell._handle_root_hub_message(request_one)  # type: ignore[attr-defined]
    await shell._handle_root_hub_message(request_two)  # type: ignore[attr-defined]

    assert attached == [shell._approval_modal]  # type: ignore[attr-defined]
    assert shell._current_prompt_approval_request is request_one  # type: ignore[attr-defined]
    assert shell._approval_modal is not None  # type: ignore[attr-defined]
    assert shell._approval_modal.request is request_one  # type: ignore[attr-defined]
    assert list(shell._pending_approval_requests) == [request_two]  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_shell_prompt_approval_modal_advances_fifo_after_current_response(
    runtime: Runtime, tmp_path: Path
) -> None:
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    shell = Shell(soul)

    runtime.approval_runtime.create_request(
        request_id="req-approval-1",
        tool_call_id="call-approval-1",
        sender="Shell",
        action="run command",
        description="pwd",
        display=[],
        source=ApprovalSource(kind="background_agent", id="task-approval-1"),
    )
    runtime.approval_runtime.create_request(
        request_id="req-approval-2",
        tool_call_id="call-approval-2",
        sender="Shell",
        action="run command",
        description="ls",
        display=[],
        source=ApprovalSource(kind="background_agent", id="task-approval-2"),
    )

    class _PromptSession:
        def attach_modal(self, _delegate) -> None:
            return None

        def detach_modal(self, _delegate) -> None:
            return None

        def invalidate(self) -> None:
            return None

        def _get_placeholder_manager(self) -> _FakePlaceholderManager:
            return _FakePlaceholderManager()

    shell._prompt_session = _PromptSession()  # type: ignore[attr-defined]

    request_one = ApprovalRequest(
        id="req-approval-1",
        tool_call_id="call-approval-1",
        sender="Shell",
        action="run command",
        description="pwd",
        source_kind="background_agent",
        source_id="task-approval-1",
    )
    request_two = ApprovalRequest(
        id="req-approval-2",
        tool_call_id="call-approval-2",
        sender="Shell",
        action="run command",
        description="ls",
        source_kind="background_agent",
        source_id="task-approval-2",
    )

    await shell._handle_root_hub_message(request_one)  # type: ignore[attr-defined]
    await shell._handle_root_hub_message(request_two)  # type: ignore[attr-defined]

    request_one.resolve("approve")
    shell._handle_prompt_approval_response(request_one, "approve")  # type: ignore[attr-defined]

    assert shell._current_prompt_approval_request is request_two  # type: ignore[attr-defined]
    assert shell._approval_modal is not None  # type: ignore[attr-defined]
    assert shell._approval_modal.request is request_two  # type: ignore[attr-defined]
    assert list(shell._pending_approval_requests) == []  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_shell_queued_approval_deduplicates(
    runtime: Runtime,
    tmp_path: Path,
) -> None:
    """Sending the same approval request twice should not create duplicates in the queue."""
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    shell = Shell(soul)

    runtime.approval_runtime.create_request(
        request_id="req-dedup",
        tool_call_id="call-dedup",
        sender="Shell",
        action="run command",
        description="pwd",
        display=[],
        source=ApprovalSource(kind="background_agent", id="task-dedup"),
    )

    request = ApprovalRequest(
        id="req-dedup",
        tool_call_id="call-dedup",
        sender="Shell",
        action="run command",
        description="pwd",
        source_kind="background_agent",
        source_id="task-dedup",
    )

    await shell._handle_root_hub_message(request)  # type: ignore[attr-defined]
    await shell._handle_root_hub_message(request)  # type: ignore[attr-defined]

    assert len(list(shell._pending_approval_requests)) == 1  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_shell_routes_foreground_approval_to_active_live_view(
    runtime: Runtime,
    tmp_path: Path,
) -> None:
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    shell = Shell(soul)

    runtime.approval_runtime.create_request(
        request_id="req-fg-1",
        tool_call_id="call-1",
        sender="Shell",
        action="run command",
        description="pwd",
        display=[],
        source=ApprovalSource(kind="foreground_turn", id="turn-1"),
    )

    class _Sink:
        def __init__(self) -> None:
            self.requests: list[ApprovalRequest] = []

        def enqueue_external_message(self, request: ApprovalRequest) -> None:
            self.requests.append(request)
            request.resolve("approve")

    sink = _Sink()
    shell._set_active_approval_sink(sink)  # type: ignore[attr-defined]

    request = ApprovalRequest(
        id="req-fg-1",
        tool_call_id="call-1",
        sender="Shell",
        action="run command",
        description="pwd",
        source_kind="foreground_turn",
        source_id="turn-1",
    )

    await shell._handle_root_hub_message(request)  # type: ignore[attr-defined]
    # Let the bridge task run
    await asyncio.sleep(0)

    record = runtime.approval_runtime.get_request("req-fg-1")
    assert record is not None
    assert record.status == "resolved"
    assert record.response == "approve"
    assert sink.requests == [request]


@pytest.mark.asyncio
async def test_shell_foreground_subagent_approval_renders_subagent_metadata(
    runtime: Runtime, tmp_path: Path, monkeypatch
) -> None:
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    shell = Shell(soul)
    runtime.subagent_store.create_instance(
        agent_id="a7654321",
        description="foreground subagent task",
        launch_spec=AgentLaunchSpec(
            agent_id="a7654321",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )

    runtime.approval_runtime.create_request(
        request_id="req-fg-subagent",
        tool_call_id="call-fg-subagent",
        sender="WriteFile",
        action="edit file",
        description="Write file `/tmp/bg.txt`",
        display=[],
        source=ApprovalSource(
            kind="foreground_turn",
            id="turn-subagent-1",
            agent_id="a7654321",
            subagent_type="coder",
        ),
    )

    class _Sink:
        def __init__(self) -> None:
            self.requests: list[ApprovalRequest] = []

        def enqueue_external_message(self, request: ApprovalRequest) -> None:
            self.requests.append(request)

    sink = _Sink()
    shell._set_active_approval_sink(sink)  # type: ignore[attr-defined]

    request = ApprovalRequest(
        id="req-fg-subagent",
        tool_call_id="call-fg-subagent",
        sender="WriteFile",
        action="edit file",
        description="Write file `/tmp/bg.txt`",
        source_kind="foreground_turn",
        source_id="turn-subagent-1",
        agent_id="a7654321",
        subagent_type="coder",
    )

    await shell._handle_root_hub_message(request)  # type: ignore[attr-defined]

    assert len(sink.requests) == 1
    enriched = sink.requests[0]
    assert enriched.agent_id == "a7654321"
    assert enriched.subagent_type == "coder"
    assert enriched.source_description == "foreground subagent task"


@pytest.mark.asyncio
async def test_shell_queues_approval_until_sink_is_ready(
    runtime: Runtime,
    tmp_path: Path,
) -> None:
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    shell = Shell(soul)

    runtime.approval_runtime.create_request(
        request_id="req-live-queued",
        tool_call_id="call-live-queued",
        sender="Shell",
        action="run command",
        description="pwd",
        display=[],
        source=ApprovalSource(kind="background_agent", id="task-live-queued"),
    )

    request = ApprovalRequest(
        id="req-live-queued",
        tool_call_id="call-live-queued",
        sender="Shell",
        action="run command",
        description="pwd",
        source_kind="background_agent",
        source_id="task-live-queued",
    )

    # Without prompt_session or sink, request is queued
    await shell._handle_root_hub_message(request)  # type: ignore[attr-defined]
    assert list(shell._pending_approval_requests) == [request]  # type: ignore[attr-defined]

    class _Sink:
        def __init__(self) -> None:
            self.requests: list[ApprovalRequest] = []

        def enqueue_external_message(self, req: ApprovalRequest) -> None:
            self.requests.append(req)

    sink = _Sink()
    shell._set_active_approval_sink(sink)  # type: ignore[attr-defined]

    # Setting sink flushes pending requests to it
    assert list(shell._pending_approval_requests) == []  # type: ignore[attr-defined]
    assert sink.requests == [request]


@pytest.mark.asyncio
async def test_shell_sink_approval_bridge_resolves_in_runtime(
    runtime: Runtime,
    tmp_path: Path,
) -> None:
    """When a sink resolves an approval, the bridge task resolves it in approval_runtime."""
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    shell = Shell(soul)

    runtime.approval_runtime.create_request(
        request_id="req-bridge",
        tool_call_id="call-bridge",
        sender="WriteFile",
        action="edit file",
        description="Write file `/tmp/bg.txt`",
        display=[],
        source=ApprovalSource(kind="background_agent", id="task-bridge"),
    )

    class _Sink:
        def enqueue_external_message(self, msg) -> None:
            if isinstance(msg, ApprovalRequest):
                msg.resolve("approve")

    sink = _Sink()
    shell._set_active_approval_sink(sink)  # type: ignore[attr-defined]

    request = ApprovalRequest(
        id="req-bridge",
        tool_call_id="call-bridge",
        sender="WriteFile",
        action="edit file",
        description="Write file `/tmp/bg.txt`",
        source_kind="background_agent",
        source_id="task-bridge",
    )

    await shell._handle_root_hub_message(request)  # type: ignore[attr-defined]
    # Let the bridge task complete
    await asyncio.sleep(0)

    record = runtime.approval_runtime.get_request("req-bridge")
    assert record is not None
    assert record.status == "resolved"
    assert record.response == "approve"


@pytest.mark.asyncio
async def test_shell_background_approval_modal_includes_display_blocks(
    runtime: Runtime,
    tmp_path: Path,
) -> None:
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    shell = Shell(soul)

    runtime.approval_runtime.create_request(
        request_id="req-bg-display",
        tool_call_id="call-bg-display",
        sender="Shell",
        action="run command",
        description="command summary",
        display=[ShellDisplayBlock(language="bash", command="echo bg-approval")],
        source=ApprovalSource(
            kind="background_agent",
            id="task-2",
            agent_id="a1234567",
            subagent_type="coder",
        ),
    )

    class _PromptSession:
        def attach_modal(self, _delegate) -> None:
            return None

        def detach_modal(self, _delegate) -> None:
            return None

        def invalidate(self) -> None:
            return None

        def _get_placeholder_manager(self) -> _FakePlaceholderManager:
            return _FakePlaceholderManager()

    shell._prompt_session = _PromptSession()  # type: ignore[attr-defined]

    request = ApprovalRequest(
        id="req-bg-display",
        tool_call_id="call-bg-display",
        sender="Shell",
        action="run command",
        description="command summary",
        display=[ShellDisplayBlock(language="bash", command="echo bg-approval")],
        source_kind="background_agent",
        source_id="task-2",
        agent_id="a1234567",
        subagent_type="coder",
    )

    await shell._handle_root_hub_message(request)  # type: ignore[attr-defined]

    assert shell._approval_modal is not None  # type: ignore[attr-defined]
    rendered = shell._approval_modal.render_running_prompt_body(120)  # type: ignore[attr-defined]
    # Strip ANSI escape codes for comparison
    import re

    plain = re.sub(r"\x1b\[[^m]*m", "", rendered.value)
    assert "echo bg-approval" in plain


@pytest.mark.asyncio
async def test_shell_background_approval_renders_subagent_metadata(
    runtime: Runtime,
    tmp_path: Path,
) -> None:
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    shell = Shell(soul)
    runtime.subagent_store.create_instance(
        agent_id="a1234567",
        description="background subagent task",
        launch_spec=AgentLaunchSpec(
            agent_id="a1234567",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )

    runtime.approval_runtime.create_request(
        request_id="req-bg-metadata",
        tool_call_id="call-bg-metadata",
        sender="Shell",
        action="run command",
        description="command summary",
        display=[ShellDisplayBlock(language="bash", command="echo bg-approval")],
        source=ApprovalSource(
            kind="background_agent",
            id="task-3",
            agent_id="a1234567",
            subagent_type="coder",
        ),
    )

    class _PromptSession:
        def attach_modal(self, _delegate) -> None:
            return None

        def detach_modal(self, _delegate) -> None:
            return None

        def invalidate(self) -> None:
            return None

        def _get_placeholder_manager(self) -> _FakePlaceholderManager:
            return _FakePlaceholderManager()

    shell._prompt_session = _PromptSession()  # type: ignore[attr-defined]

    request = ApprovalRequest(
        id="req-bg-metadata",
        tool_call_id="call-bg-metadata",
        sender="Shell",
        action="run command",
        description="command summary",
        display=[ShellDisplayBlock(language="bash", command="echo bg-approval")],
        source_kind="background_agent",
        source_id="task-3",
        agent_id="a1234567",
        subagent_type="coder",
    )

    await shell._handle_root_hub_message(request)  # type: ignore[attr-defined]

    assert shell._approval_modal is not None  # type: ignore[attr-defined]
    rendered = shell._approval_modal.render_running_prompt_body(120)  # type: ignore[attr-defined]
    assert "Subagent: coder (a1234567)" in rendered.value
    assert "Task: background subagent task" in rendered.value


@pytest.mark.asyncio
async def test_shell_sink_bridge_passes_feedback_to_runtime(
    runtime: Runtime,
    tmp_path: Path,
) -> None:
    """When a sink resolves an approval with feedback, the bridge should
    pass feedback through to approval_runtime.resolve()."""
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    shell = Shell(soul)

    runtime.approval_runtime.create_request(
        request_id="req-sink-fb",
        tool_call_id="call-sink-fb",
        sender="Shell",
        action="run command",
        description="rm -rf /",
        display=[],
        source=ApprovalSource(kind="foreground_turn", id="turn-fb"),
    )

    class _Sink:
        def enqueue_external_message(self, msg) -> None:
            if isinstance(msg, ApprovalRequest):
                # Simulate a rejection with feedback via the wire-level resolve
                msg.resolve("reject", feedback="use rm -i instead")

    sink = _Sink()
    shell._set_active_approval_sink(sink)  # type: ignore[attr-defined]

    request = ApprovalRequest(
        id="req-sink-fb",
        tool_call_id="call-sink-fb",
        sender="Shell",
        action="run command",
        description="rm -rf /",
        source_kind="foreground_turn",
        source_id="turn-fb",
    )

    await shell._handle_root_hub_message(request)  # type: ignore[attr-defined]
    # Let the bridge task complete
    await asyncio.sleep(0)

    record = runtime.approval_runtime.get_request("req-sink-fb")
    assert record is not None
    assert record.status == "resolved"
    assert record.response == "reject"
    assert record.feedback == "use rm -i instead"


@pytest.mark.asyncio
async def test_set_active_approval_sink_does_not_flush_in_interactive_mode(
    runtime: Runtime,
    tmp_path: Path,
) -> None:
    """In interactive mode (_prompt_session is set), pending approval requests
    should NOT be flushed to the live view sink.  They must stay in the pending
    queue so the prompt modal can present them to the user.

    Regression test for: subagent WriteFile approval requests silently lost
    when _set_active_approval_sink flushes to a _PromptLiveView that cannot
    render approval modals.
    """
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    shell = Shell(soul)

    # Simulate interactive mode by setting _prompt_session
    shell._prompt_session = Mock()  # type: ignore[attr-defined]

    # Create a pending approval request in the runtime
    runtime.approval_runtime.create_request(
        request_id="req-interactive-flush",
        tool_call_id="call-interactive-flush",
        sender="WriteFile",
        action="edit file",
        description="Write file /tmp/test.txt",
        display=[],
        source=ApprovalSource(kind="foreground_turn", id="turn-interactive"),
    )

    # Queue an approval request (simulating what _handle_root_hub_message does)
    request = ApprovalRequest(
        id="req-interactive-flush",
        tool_call_id="call-interactive-flush",
        sender="WriteFile",
        action="edit file",
        description="Write file /tmp/test.txt",
        source_kind="foreground_turn",
        source_id="turn-interactive",
    )
    shell._queue_approval_request(request)  # type: ignore[attr-defined]
    assert len(shell._pending_approval_requests) == 1  # type: ignore[attr-defined]

    # Now set a sink — in interactive mode, this should NOT flush pending requests
    class _Sink:
        def __init__(self) -> None:
            self.requests: list[ApprovalRequest] = []

        def enqueue_external_message(self, req: ApprovalRequest) -> None:
            self.requests.append(req)

    sink = _Sink()
    shell._set_active_approval_sink(sink)  # type: ignore[attr-defined]

    # Requests must remain in pending queue for the prompt modal
    assert len(shell._pending_approval_requests) == 1  # type: ignore[attr-defined]
    # Sink should NOT have received any requests
    assert sink.requests == []
