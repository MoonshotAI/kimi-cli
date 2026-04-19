from __future__ import annotations

import asyncio
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Self

import pytest
from kosong.chat_provider import StreamedMessagePart, ThinkingEffort, TokenUsage
from kosong.message import Message, TextPart
from kosong.tooling.empty import EmptyToolset

from kimi_cli.app import KimiCLI
from kimi_cli.approval_runtime import ApprovalSource
from kimi_cli.background import TaskRuntime, TaskSpec
from kimi_cli.llm import LLM
from kimi_cli.notifications import NotificationEvent
from kimi_cli.soul import StatusSnapshot, _current_wire, run_soul
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.utils.aioqueue import QueueShutDown
from kimi_cli.wire import Wire
from kimi_cli.wire.types import ApprovalRequest, ApprovalResponse, Notification


class _SequenceStream:
    def __init__(self, parts: Sequence[StreamedMessagePart]) -> None:
        self._parts = list(parts)

    def __aiter__(self) -> Self:
        return self

    async def __anext__(self) -> StreamedMessagePart:
        if not self._parts:
            raise StopAsyncIteration
        return self._parts.pop(0)

    @property
    def id(self) -> str | None:
        return "notification-sequence"

    @property
    def usage(self) -> TokenUsage | None:
        return None


class _SequenceProvider:
    name = "notification-sequence"

    def __init__(self, parts: Sequence[StreamedMessagePart]) -> None:
        self._parts = list(parts)

    @property
    def model_name(self) -> str:
        return "notification-sequence"

    @property
    def thinking_effort(self) -> ThinkingEffort | None:
        return None

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[object],
        history: Sequence[Message],
    ) -> _SequenceStream:
        return _SequenceStream(self._parts)

    def with_thinking(self, effort: ThinkingEffort) -> Self:
        return self


def _runtime_with_llm(runtime: Runtime, llm: LLM) -> Runtime:
    return Runtime(
        config=runtime.config,
        llm=llm,
        session=runtime.session,
        builtin_args=runtime.builtin_args,
        denwa_renji=runtime.denwa_renji,
        approval=runtime.approval,
        labor_market=runtime.labor_market,
        environment=runtime.environment,
        notifications=runtime.notifications,
        background_tasks=runtime.background_tasks,
        skills=runtime.skills,
        oauth=runtime.oauth,
        additional_dirs=runtime.additional_dirs,
        skills_dirs=runtime.skills_dirs,
        role=runtime.role,
    )


def _make_soul(runtime: Runtime, tmp_path: Path) -> tuple[KimiSoul, Context]:
    llm = LLM(
        chat_provider=_SequenceProvider([TextPart(text="done")]),
        max_context_size=100_000,
        capabilities=set(),
    )
    agent = Agent(
        name="Notification Agent",
        system_prompt="System prompt.",
        toolset=EmptyToolset(),
        runtime=_runtime_with_llm(runtime, llm),
    )
    context = Context(file_backend=tmp_path / "history.jsonl")
    return KimiSoul(agent, context=context), context


def _write_completed_task(runtime: Runtime, task_id: str) -> None:
    spec = TaskSpec(
        id=task_id,
        kind="bash",
        session_id=runtime.session.id,
        description="background completion",
        tool_call_id="tool-8",
        command="echo done",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=60,
    )
    runtime.background_tasks.store.create_task(spec)
    runtime.background_tasks.store.output_path(spec.id).write_text(
        "line 1\nline 2\n", encoding="utf-8"
    )
    runtime.background_tasks.store.write_runtime(
        spec.id,
        TaskRuntime(
            status="completed",
            exit_code=0,
            finished_at=time.time(),
            updated_at=time.time(),
        ),
    )


@pytest.mark.asyncio
async def test_kimisoul_appends_notification_message(runtime: Runtime, tmp_path: Path) -> None:
    _write_completed_task(runtime, "b3333333")
    runtime.background_tasks.publish_terminal_notifications()

    soul, context = _make_soul(runtime, tmp_path)

    async def _drain_ui(wire: Wire) -> None:
        wire_ui = wire.ui_side(merge=True)
        while True:
            try:
                await wire_ui.receive()
            except QueueShutDown:
                return

    await run_soul(soul, "check status", _drain_ui, asyncio.Event())

    notification_texts = [
        message.extract_text("\n")
        for message in context.history
        if "<notification " in message.extract_text("\n")
    ]
    assert len(notification_texts) == 1
    assert "Task ID: b3333333" in notification_texts[0]
    assert "line 2" in notification_texts[0]


@pytest.mark.asyncio
async def test_run_soul_emits_wire_notifications(runtime: Runtime, tmp_path: Path) -> None:
    runtime.notifications.publish(
        NotificationEvent(
            id=runtime.notifications.new_id(),
            category="system",
            type="system.info",
            source_kind="test",
            source_id="source-1",
            title="Test notification",
            body="hello from notification",
            targets=["wire"],
        )
    )
    soul, _ = _make_soul(runtime, tmp_path)
    seen: list[Notification] = []

    async def _ui_loop(wire: Wire) -> None:
        wire_ui = wire.ui_side(merge=False)
        while True:
            try:
                msg = await wire_ui.receive()
            except QueueShutDown:
                return
            if isinstance(msg, Notification):
                seen.append(msg)

    await run_soul(soul, "ping", _ui_loop, asyncio.Event(), runtime=runtime)

    assert len(seen) == 1
    assert seen[0].title == "Test notification"
    assert seen[0].body == "hello from notification"


@pytest.mark.asyncio
async def test_kimi_cli_run_yields_root_hub_approvals(runtime: Runtime) -> None:
    class _ApprovalOnlySoul:
        def __init__(self, runtime: Runtime) -> None:
            self.runtime = runtime

        @property
        def name(self) -> str:
            return "Approval Soul"

        @property
        def model_name(self) -> str:
            return ""

        @property
        def model_capabilities(self):
            return None

        @property
        def thinking(self):
            return None

        @property
        def status(self) -> StatusSnapshot:
            return StatusSnapshot(context_usage=0.0)

        @property
        def available_slash_commands(self):
            return []

        async def run(self, _user_input: str) -> None:
            assert self.runtime.approval_runtime is not None
            self.runtime.approval_runtime.create_request(
                request_id="req-run-1",
                tool_call_id="call-run-1",
                sender="WriteFile",
                action="write_file",
                description="write file",
                display=[],
                source=ApprovalSource(kind="foreground_turn", id="turn-run-1"),
            )

    cli = KimiCLI(_ApprovalOnlySoul(runtime), runtime, {})  # type: ignore[arg-type]

    seen: list[ApprovalRequest] = []
    async for msg in cli.run("ping", asyncio.Event()):
        if isinstance(msg, ApprovalRequest):
            seen.append(msg)
            break

    assert len(seen) == 1
    assert seen[0].id == "req-run-1"
    assert seen[0].sender == "WriteFile"


@pytest.mark.asyncio
async def test_kimi_cli_run_bridges_approval_resolution_back_to_runtime(runtime: Runtime) -> None:
    class _ApprovalRoundTripSoul:
        def __init__(self, runtime: Runtime) -> None:
            self.runtime = runtime
            self.response: str | None = None
            self.feedback: str = ""

        @property
        def name(self) -> str:
            return "Approval Round Trip Soul"

        @property
        def model_name(self) -> str:
            return ""

        @property
        def model_capabilities(self):
            return None

        @property
        def thinking(self):
            return None

        @property
        def status(self) -> StatusSnapshot:
            return StatusSnapshot(context_usage=0.0)

        @property
        def available_slash_commands(self):
            return []

        async def run(self, _user_input: str) -> None:
            assert self.runtime.approval_runtime is not None
            request = self.runtime.approval_runtime.create_request(
                request_id="req-run-bridge-1",
                tool_call_id="call-run-bridge-1",
                sender="WriteFile",
                action="edit file",
                description="write file",
                display=[],
                source=ApprovalSource(kind="foreground_turn", id="turn-run-bridge-1"),
            )
            self.response, self.feedback = await self.runtime.approval_runtime.wait_for_response(
                request.id
            )

    soul = _ApprovalRoundTripSoul(runtime)
    cli = KimiCLI(soul, runtime, {})  # type: ignore[arg-type]

    seen_responses: list[ApprovalResponse] = []

    async def _collect() -> None:
        async for msg in cli.run("ping", asyncio.Event()):
            if isinstance(msg, ApprovalRequest):
                msg.resolve("approve")
            elif isinstance(msg, ApprovalResponse):
                seen_responses.append(msg)

    await asyncio.wait_for(_collect(), timeout=1.0)

    assert soul.response == "approve"
    assert soul.feedback == ""
    assert runtime.approval_runtime is not None
    record = runtime.approval_runtime.get_request("req-run-bridge-1")
    assert record is not None
    assert record.status == "resolved"
    assert record.response == "approve"
    assert [response.request_id for response in seen_responses] == ["req-run-bridge-1"]


@pytest.mark.asyncio
async def test_kimi_cli_run_replays_pending_approvals_from_previous_turn(runtime: Runtime) -> None:
    assert runtime.approval_runtime is not None
    runtime.approval_runtime.create_request(
        request_id="req-run-replay-1",
        tool_call_id="call-run-replay-1",
        sender="WriteFile",
        action="edit file",
        description="write file",
        display=[],
        source=ApprovalSource(kind="background_agent", id="task-run-replay-1"),
    )

    class _PendingApprovalSoul:
        def __init__(self, runtime: Runtime) -> None:
            self.runtime = runtime
            self.response: str | None = None
            self.feedback: str = ""

        @property
        def name(self) -> str:
            return "Pending Approval Soul"

        @property
        def model_name(self) -> str:
            return ""

        @property
        def model_capabilities(self):
            return None

        @property
        def thinking(self):
            return None

        @property
        def status(self) -> StatusSnapshot:
            return StatusSnapshot(context_usage=0.0)

        @property
        def available_slash_commands(self):
            return []

        async def run(self, _user_input: str) -> None:
            assert self.runtime.approval_runtime is not None
            self.response, self.feedback = await self.runtime.approval_runtime.wait_for_response(
                "req-run-replay-1"
            )

    soul = _PendingApprovalSoul(runtime)
    cli = KimiCLI(soul, runtime, {})  # type: ignore[arg-type]

    seen_requests: list[ApprovalRequest] = []

    async def _collect() -> None:
        async for msg in cli.run("ping", asyncio.Event()):
            if isinstance(msg, ApprovalRequest):
                seen_requests.append(msg)
                msg.resolve("approve")

    await asyncio.wait_for(_collect(), timeout=1.0)

    assert [request.id for request in seen_requests] == ["req-run-replay-1"]
    assert seen_requests[0].source_kind == "background_agent"
    assert soul.response == "approve"
    assert soul.feedback == ""
    assert runtime.approval_runtime is not None
    assert runtime.approval_runtime.list_pending() == []


@pytest.mark.asyncio
async def test_run_soul_flushes_wire_notifications_published_right_before_turn_end(
    runtime: Runtime,
) -> None:
    class _LateNotificationSoul:
        def __init__(self, runtime: Runtime) -> None:
            self.runtime = runtime

        async def run(self, _user_input: str) -> None:
            await asyncio.sleep(0.05)
            self.runtime.notifications.publish(
                NotificationEvent(
                    id=self.runtime.notifications.new_id(),
                    category="system",
                    type="system.info",
                    source_kind="test",
                    source_id="source-2",
                    title="Late notification",
                    body="published right before turn end",
                    targets=["wire"],
                )
            )

    seen: list[Notification] = []

    async def _ui_loop(wire: Wire) -> None:
        wire_ui = wire.ui_side(merge=False)
        while True:
            try:
                msg = await wire_ui.receive()
            except QueueShutDown:
                return
            if isinstance(msg, Notification):
                seen.append(msg)

    await run_soul(
        _LateNotificationSoul(runtime),  # type: ignore[arg-type]
        "ping",
        _ui_loop,
        asyncio.Event(),
        runtime=runtime,
    )

    assert [msg.title for msg in seen] == ["Late notification"]


@pytest.mark.asyncio
async def test_compaction_appends_active_task_snapshot(runtime: Runtime, tmp_path: Path) -> None:
    _write_completed_task(runtime, "b3333344")
    running_spec = TaskSpec(
        id="b3333345",
        kind="bash",
        session_id=runtime.session.id,
        description="still running",
        tool_call_id="tool-9",
        command="sleep 10",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=60,
    )
    runtime.background_tasks.store.create_task(running_spec)
    runtime.background_tasks.store.write_runtime(
        running_spec.id,
        TaskRuntime(status="running", updated_at=time.time()),
    )

    soul, context = _make_soul(runtime, tmp_path)
    await context.append_message(
        [
            Message(role="user", content=[TextPart(text="message 1")]),
            Message(role="assistant", content=[TextPart(text="message 2")]),
            Message(role="user", content=[TextPart(text="message 3")]),
            Message(role="assistant", content=[TextPart(text="message 4")]),
        ]
    )

    wire = Wire()
    token = _current_wire.set(wire)
    try:
        await soul.compact_context()
    finally:
        _current_wire.reset(token)

    texts = [message.extract_text("\n") for message in context.history]
    assert any("<active-background-tasks>" in text for text in texts)
    assert any("task_id: b3333345" in text for text in texts)
