"""Background hook triggers must survive garbage collection.

``asyncio`` only keeps weak references to running tasks, so
``asyncio.create_task(engine.trigger(...))`` followed by discarding the local
variable lets the GC collect a still-pending task. The hook subprocess is then
never awaited and the hook silently does not run.
``HookEngine.fire_and_forget_trigger`` exists to hold a strong reference for the
lifetime of the task; these tests pin that behaviour and check that the
fire-and-forget call sites use it instead of rolling their own ``create_task``.
"""

import ast
import gc
import inspect
from pathlib import Path

import pytest

from kimi_cli.hooks.config import HookDef
from kimi_cli.hooks.engine import HookEngine
from kimi_cli.soul import kimisoul, toolset


@pytest.mark.asyncio
async def test_pending_task_survives_gc_and_still_runs(tmp_path):
    """The task must complete even when the caller keeps no reference to it."""
    marker = tmp_path / "hook-ran"
    hooks = [
        HookDef(
            event="PostToolUse",
            command=f"sleep 0.2 && touch {marker}",
            timeout=5,
        )
    ]
    engine = HookEngine(hooks, cwd=str(tmp_path))

    def fire_without_keeping_a_reference() -> None:
        engine.fire_and_forget_trigger("PostToolUse", input_data={"tool_name": "Shell"})

    fire_without_keeping_a_reference()
    gc.collect()

    pending = set(engine._pending_fire_and_forget)
    assert len(pending) == 1, "engine must hold a strong reference to the pending task"

    await next(iter(pending))
    assert marker.exists(), "hook command did not run to completion"


@pytest.mark.asyncio
async def test_completed_task_is_released(tmp_path):
    """The strong reference must not leak once the task finishes."""
    engine = HookEngine([HookDef(event="Stop", command="exit 0", timeout=5)], cwd=str(tmp_path))

    task = engine.fire_and_forget_trigger("Stop", input_data={})
    await task

    assert task not in engine._pending_fire_and_forget


@pytest.mark.asyncio
async def test_failing_command_does_not_leak_the_reference(tmp_path):
    """A hook whose command cannot be run must still release its reference."""
    engine = HookEngine(
        [HookDef(event="Stop", command="definitely-not-a-real-command", timeout=5)],
        cwd=str(tmp_path),
    )

    task = engine.fire_and_forget_trigger("Stop", input_data={})
    await task

    assert task.exception() is None
    assert task not in engine._pending_fire_and_forget


def _bare_create_task_hook_triggers(module) -> list[str]:
    """Return `Event` names triggered via a bare `create_task` in `module`."""
    source = Path(inspect.getsourcefile(module)).read_text(encoding="utf-8")
    found: list[str] = []

    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr == "create_task"):
            continue
        for inner in ast.walk(node):
            if (
                isinstance(inner, ast.Call)
                and isinstance(inner.func, ast.Attribute)
                and inner.func.attr == "trigger"
                and inner.args
                and isinstance(inner.args[0], ast.Constant)
            ):
                found.append(inner.args[0].value)

    return found


@pytest.mark.parametrize("module", [toolset, kimisoul], ids=lambda m: m.__name__)
def test_no_bare_create_task_around_hook_triggers(module):
    """Fire-and-forget call sites must go through `fire_and_forget_trigger`."""
    assert _bare_create_task_hook_triggers(module) == []
