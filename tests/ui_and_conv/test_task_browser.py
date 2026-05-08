from __future__ import annotations

import asyncio
import time
from pathlib import Path

from kosong.tooling.empty import EmptyToolset

from kimi_cli.background import TaskRuntime, TaskSpec, TaskStatus
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell import task_browser as task_browser_module
from kimi_cli.ui.shell.task_browser import TaskBrowserApp, TaskBrowserModel


def _make_soul(runtime: Runtime, tmp_path: Path) -> KimiSoul:
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    return KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))


def _write_task(
    runtime: Runtime,
    task_id: str,
    *,
    status: TaskStatus,
    description: str,
    output: str = "",
    created_at: float | None = None,
    updated_at: float | None = None,
) -> TaskSpec:
    created = created_at if created_at is not None else time.time()
    spec = TaskSpec(
        id=task_id,
        kind="bash",
        session_id=runtime.session.id,
        description=description,
        tool_call_id="tool-task",
        command="make build",
        shell_name="bash",
        shell_path="/bin/bash",
        cwd=str(runtime.session.work_dir),
        timeout_s=60,
        created_at=created,
    )
    store = runtime.background_tasks.store
    store.create_task(spec)
    store.output_path(task_id).write_text(output, encoding="utf-8")
    store.write_runtime(
        task_id,
        TaskRuntime(
            status=status,
            started_at=time.time() - 10,
            updated_at=updated_at if updated_at is not None else time.time(),
            finished_at=time.time()
            if status in {"completed", "failed", "killed", "lost"}
            else None,
        ),
    )
    return spec


def test_task_browser_model_filters_active_tasks(runtime: Runtime, tmp_path: Path) -> None:
    soul = _make_soul(runtime, tmp_path)
    running = _write_task(runtime, "b1234567", status="running", description="build", output="ok\n")
    _write_task(runtime, "b1234568", status="completed", description="done", output="done\n")

    model = TaskBrowserModel(soul=soul, filter_mode="active")
    values, selected = model.refresh()

    assert [task_id for task_id, _label in values] == [running.id]
    assert selected == running.id


def test_task_browser_model_preview_is_shorter_than_full_output(
    runtime: Runtime, tmp_path: Path
) -> None:
    soul = _make_soul(runtime, tmp_path)
    spec = _write_task(
        runtime,
        "b1234567",
        status="running",
        description="build",
        output="\n".join(f"line {i}" for i in range(1, 21)),
    )

    model = TaskBrowserModel(soul=soul)
    model.refresh(spec.id)

    preview = model.preview_text(spec.id)
    full_output = model.full_output(spec.id)

    assert "line 1" not in preview.splitlines()
    assert "line 20" in preview.splitlines()
    assert "line 1" in full_output.splitlines()
    assert "line 20" in full_output.splitlines()


def test_task_browser_model_summary_counts_all_tasks(runtime: Runtime, tmp_path: Path) -> None:
    soul = _make_soul(runtime, tmp_path)
    _write_task(runtime, "b1234567", status="running", description="build")
    _write_task(runtime, "b1234568", status="failed", description="lint")
    _write_task(runtime, "b1234569", status="completed", description="docs")

    model = TaskBrowserModel(soul=soul)
    model.refresh()

    header = "".join(t[1] for t in model.summary_fragments())

    assert "1 running" in header
    assert "1 failed" in header
    assert "1 completed" in header
    assert "3 total" in header


def test_task_browser_model_keeps_running_tasks_in_stable_creation_order(
    runtime: Runtime, tmp_path: Path
) -> None:
    soul = _make_soul(runtime, tmp_path)
    now = time.time()
    _write_task(
        runtime,
        "b1234567",
        status="running",
        description="oldest",
        created_at=now - 30,
        updated_at=now - 1,
    )
    _write_task(
        runtime,
        "b1234568",
        status="running",
        description="middle",
        created_at=now - 20,
        updated_at=now - 10,
    )
    _write_task(
        runtime,
        "b1234569",
        status="running",
        description="newest",
        created_at=now - 10,
        updated_at=now - 20,
    )

    model = TaskBrowserModel(soul=soul)
    values, _selected = model.refresh()

    assert [task_id for task_id, _label in values] == ["b1234567", "b1234568", "b1234569"]


def test_task_browser_footer_keeps_hotkeys_visible_after_flash_message(
    runtime: Runtime, tmp_path: Path
) -> None:
    soul = _make_soul(runtime, tmp_path)
    model = TaskBrowserModel(soul=soul)
    model.set_message("Stop cancelled.")

    footer = "".join(t[1] for t in model.footer_fragments(None))

    assert "Enter" in footer
    assert "S" in footer
    assert "Stop cancelled." in footer


def test_task_browser_app_construction_smoke(runtime: Runtime, tmp_path: Path) -> None:
    soul = _make_soul(runtime, tmp_path)
    app = TaskBrowserApp(soul)

    assert app._app.full_screen is True
    assert app._app.erase_when_done is True
    assert app._app.refresh_interval == 1.0

    kb = app._app.key_bindings
    assert kb is not None
    shortcuts = {
        tuple(getattr(key, "value", key) for key in binding.keys) for binding in kb.bindings
    }

    assert ("c-m",) in shortcuts
    assert ("o",) in shortcuts


async def test_task_browser_output_uses_coroutine_wrapper(
    runtime: Runtime, tmp_path: Path, monkeypatch
) -> None:
    soul = _make_soul(runtime, tmp_path)
    _write_task(runtime, "b1234567", status="running", description="build", output="line\n")
    app = TaskBrowserApp(soul)

    scheduled: list[object] = []
    run_calls: list[object] = []

    class _DummyApp:
        def create_background_task(self, coro):
            scheduled.append(coro)
            return coro

    async def fake_run_in_terminal(func, in_executor=False):
        run_calls.append(func)
        return None

    monkeypatch.setattr(task_browser_module, "run_in_terminal", fake_run_in_terminal)

    app._open_output(_DummyApp(), "b1234567")  # type: ignore[arg-type]

    assert len(scheduled) == 1
    assert asyncio.iscoroutine(scheduled[0])

    await scheduled[0]

    assert len(run_calls) == 1


def test_task_browser_toggle_filter_rebuilds_visible_task_list(
    runtime: Runtime, tmp_path: Path
) -> None:
    soul = _make_soul(runtime, tmp_path)
    _write_task(runtime, "b1234567", status="running", description="build")
    _write_task(runtime, "b1234568", status="completed", description="done")
    app = TaskBrowserApp(soul)

    assert [task_id for task_id, _label in app._task_list.values] == ["b1234567", "b1234568"]

    app._toggle_filter()

    assert app._model.filter_mode == "active"
    assert [task_id for task_id, _label in app._task_list.values] == ["b1234567"]
    assert app._task_list.current_value == "b1234567"


def test_task_browser_stop_flow_sets_pending_and_can_cancel(
    runtime: Runtime, tmp_path: Path
) -> None:
    soul = _make_soul(runtime, tmp_path)
    spec = _write_task(runtime, "b1234567", status="running", description="watch")
    app = TaskBrowserApp(soul)
    app._task_list.current_value = spec.id

    app._request_stop_for_selected_task()

    assert app._model.pending_stop_task_id == spec.id
    assert app._model.message == ""

    app._cancel_stop_request()

    assert app._model.pending_stop_task_id is None
    assert app._model.current_message() == "Stop cancelled."


def test_task_browser_confirm_stop_writes_control_for_selected_task(
    runtime: Runtime, tmp_path: Path
) -> None:
    soul = _make_soul(runtime, tmp_path)
    spec = _write_task(runtime, "b1234567", status="running", description="watch")
    app = TaskBrowserApp(soul)
    app._task_list.current_value = spec.id
    app._request_stop_for_selected_task()

    app._confirm_stop_request()

    control = runtime.background_tasks.store.read_control(spec.id)
    assert control.kill_requested_at is not None
    assert app._model.pending_stop_task_id is None
    assert app._model.current_message() == f"Stop requested for task {spec.id}."


def test_task_browser_stop_on_terminal_task_surfaces_message(
    runtime: Runtime, tmp_path: Path
) -> None:
    soul = _make_soul(runtime, tmp_path)
    spec = _write_task(runtime, "b1234567", status="completed", description="done")
    app = TaskBrowserApp(soul)
    app._task_list.current_value = spec.id

    app._request_stop_for_selected_task()

    assert app._model.pending_stop_task_id is None
    assert app._model.current_message() == f"Task {spec.id} is already completed."
