"""Tests for SetTodoList tool."""

from __future__ import annotations

import pytest

from kimi_cli.soul.agent import Runtime
from kimi_cli.tools.todo import Params, SetTodoList, Todo


@pytest.fixture
def set_todo_list_tool(runtime: Runtime) -> SetTodoList:
    """Create a SetTodoList tool instance with runtime."""
    return SetTodoList(runtime)


class TestSetTodoListOutputNotEmpty:
    """Regression test for issue #1710: SetTodoList storm.

    The root cause is that SetTodoList returned output="" which meant the model
    only saw '<system>Todo list updated</system>' — no confirmation of what it
    saved. This led to repeated calls (a "storm") especially when Shell was disabled.
    """

    async def test_write_mode_returns_nonempty_output(self, set_todo_list_tool: SetTodoList):
        """When todos are provided, the tool must return a non-empty output
        so the model gets meaningful feedback (not just 'Todo list updated')."""
        params = Params(
            todos=[
                Todo(title="Analyze code", status="pending"),
                Todo(title="Write tests", status="in_progress"),
                Todo(title="Read requirements", status="done"),
            ]
        )
        result = await set_todo_list_tool(params)
        assert not result.is_error
        # The critical assertion: output must NOT be empty
        assert result.output != "", (
            "SetTodoList output must not be empty — this is the root cause of issue #1710. "
            "The model needs to see confirmation of the todo state it just set."
        )
        assert result.message == "Todo list updated"

    async def test_read_mode_returns_current_todos(self, set_todo_list_tool: SetTodoList):
        """When no todos are provided (None), the tool should return the current
        todo list from persistent storage, including status."""
        # First write some todos
        write_params = Params(
            todos=[
                Todo(title="Task A", status="pending"),
                Todo(title="Task B", status="done"),
            ]
        )
        await set_todo_list_tool(write_params)

        # Then read without providing todos
        read_params = Params(todos=None)
        result = await set_todo_list_tool(read_params)
        assert not result.is_error
        assert "Task A" in result.output
        assert "Task B" in result.output
        assert "pending" in result.output
        assert "done" in result.output

    async def test_read_mode_empty_list(self, set_todo_list_tool: SetTodoList):
        """Reading with no prior todos should return a clear empty message."""
        read_params = Params(todos=None)
        result = await set_todo_list_tool(read_params)
        assert not result.is_error
        assert result.output  # non-empty even when no todos

    async def test_write_empty_list_clears_todos(self, set_todo_list_tool: SetTodoList):
        """Passing an empty list [] should clear all todos."""
        # Write some todos first
        write_params = Params(todos=[Todo(title="Task A", status="pending")])
        await set_todo_list_tool(write_params)

        # Clear with empty list
        clear_params = Params(todos=[])
        result = await set_todo_list_tool(clear_params)
        assert not result.is_error
        assert result.output == "Todo list updated"

        # Verify cleared
        read_params = Params(todos=None)
        result = await set_todo_list_tool(read_params)
        assert isinstance(result.output, str)
        assert "empty" in result.output.lower() or result.output.strip() == "Todo list is empty."

    async def test_root_todos_persisted_to_disk(
        self, set_todo_list_tool: SetTodoList, runtime: Runtime
    ):
        """Write mode should persist todos to disk via SessionState."""
        from kimi_cli.session_state import load_session_state

        params = Params(
            todos=[
                Todo(title="Disk task", status="in_progress"),
                Todo(title="Another task", status="done"),
            ]
        )
        await set_todo_list_tool(params)

        # Verify by loading directly from disk, bypassing in-memory state
        disk_state = load_session_state(runtime.session.dir)
        assert len(disk_state.todos) == 2
        assert disk_state.todos[0].title == "Disk task"
        assert disk_state.todos[0].status == "in_progress"
        assert disk_state.todos[1].title == "Another task"
        assert disk_state.todos[1].status == "done"

    async def test_write_mode_display_block(self, set_todo_list_tool: SetTodoList):
        """Write mode should still produce TodoDisplayBlock for UI rendering."""
        from kimi_cli.tools.display import TodoDisplayBlock

        params = Params(todos=[Todo(title="UI task", status="pending")])
        result = await set_todo_list_tool(params)
        assert len(result.display) == 1
        assert isinstance(result.display[0], TodoDisplayBlock)
        assert result.display[0].items[0].title == "UI task"

    async def test_read_mode_no_display_block(self, set_todo_list_tool: SetTodoList):
        """Read mode should not produce display blocks (no UI side-effect)."""
        read_params = Params(todos=None)
        result = await set_todo_list_tool(read_params)
        assert result.display == []


class TestSetTodoListSubagent:
    """Test SetTodoList behavior in subagent context."""

    async def test_subagent_uses_independent_storage(self, runtime: Runtime):
        """Subagent todos should be stored independently from root agent."""
        # Create root tool and set a todo
        root_tool = SetTodoList(runtime)
        await root_tool(Params(todos=[Todo(title="Root task", status="pending")]))

        # Create a subagent runtime
        subagent_runtime = runtime.copy_for_subagent(
            agent_id="test-sub-1",
            subagent_type="coder",
        )
        # Initialize the subagent instance directory
        assert subagent_runtime.subagent_store is not None
        subagent_runtime.subagent_store.instance_dir("test-sub-1", create=True)

        sub_tool = SetTodoList(subagent_runtime)

        # Subagent should start with empty todos
        result = await sub_tool(Params(todos=None))
        assert isinstance(result.output, str)
        assert "empty" in result.output.lower() or "Root task" not in result.output

        # Subagent writes its own todo
        await sub_tool(Params(todos=[Todo(title="Sub task", status="in_progress")]))
        result = await sub_tool(Params(todos=None))
        assert "Sub task" in result.output

        # Root agent should still have its own todo
        result = await root_tool(Params(todos=None))
        assert "Root task" in result.output
        assert "Sub task" not in result.output

    async def test_subagent_no_store_or_id_graceful(self, runtime: Runtime):
        """When subagent_store or subagent_id is None, save is a no-op and load returns empty."""
        subagent_runtime = runtime.copy_for_subagent(
            agent_id="test-sub-2",
            subagent_type="coder",
        )
        # Force store/id to None to simulate edge case
        subagent_runtime.subagent_store = None
        subagent_runtime.subagent_id = None

        tool = SetTodoList(subagent_runtime)

        # Write should silently succeed (no-op)
        result = await tool(Params(todos=[Todo(title="Ghost task", status="pending")]))
        assert not result.is_error
        assert result.output == "Todo list updated"

        # Read should return empty
        result = await tool(Params(todos=None))
        assert not result.is_error
        assert isinstance(result.output, str)
        assert "empty" in result.output.lower()

    async def test_corrupted_subagent_state_file(self, runtime: Runtime):
        """Corrupted subagent state.json should be handled gracefully."""
        subagent_runtime = runtime.copy_for_subagent(
            agent_id="test-sub-3",
            subagent_type="coder",
        )
        assert subagent_runtime.subagent_store is not None
        instance_dir = subagent_runtime.subagent_store.instance_dir("test-sub-3", create=True)

        # Write corrupted JSON to state.json
        state_file = instance_dir / "state.json"
        state_file.write_text("not valid json {{{", encoding="utf-8")

        tool = SetTodoList(subagent_runtime)

        # Read should return empty (corrupted file treated as empty)
        result = await tool(Params(todos=None))
        assert not result.is_error
        assert isinstance(result.output, str)
        assert "empty" in result.output.lower()

        # Write should overwrite the corrupted file successfully
        result = await tool(Params(todos=[Todo(title="Recovery task", status="pending")]))
        assert not result.is_error

        # Verify recovery
        result = await tool(Params(todos=None))
        assert "Recovery task" in result.output

    async def test_subagent_malformed_individual_item(self, runtime: Runtime):
        """Malformed individual items in state.json should be skipped, valid ones preserved."""
        import json

        subagent_runtime = runtime.copy_for_subagent(
            agent_id="test-sub-4",
            subagent_type="coder",
        )
        assert subagent_runtime.subagent_store is not None
        instance_dir = subagent_runtime.subagent_store.instance_dir("test-sub-4", create=True)

        # Write JSON with one valid and one invalid todo item
        state_file = instance_dir / "state.json"
        state_file.write_text(
            json.dumps(
                {
                    "todos": [
                        {"title": "Valid task", "status": "pending"},
                        {"bad": "item"},  # missing title and status
                        {"title": "Also valid", "status": "done"},
                    ]
                }
            ),
            encoding="utf-8",
        )

        tool = SetTodoList(subagent_runtime)
        result = await tool(Params(todos=None))
        assert not result.is_error
        assert "Valid task" in result.output
        assert "Also valid" in result.output
        # The malformed item should be silently skipped
        assert "bad" not in result.output
