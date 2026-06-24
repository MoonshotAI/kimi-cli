import json
from pathlib import Path
from typing import Any, Literal, cast, override

from kosong.tooling import CallableTool2, ToolReturnValue
from pydantic import BaseModel, Field

from kimi_cli.session_state import TodoItemState
from kimi_cli.soul.agent import Runtime
from kimi_cli.tools.display import TodoDisplayBlock, TodoDisplayItem
from kimi_cli.tools.utils import load_desc
from kimi_cli.utils.logging import logger


class Todo(BaseModel):
    title: str = Field(description="The title of the todo", min_length=1)
    status: Literal["pending", "in_progress", "done"] = Field(description="The status of the todo")


class Params(BaseModel):
    todos: list[Todo] | None = Field(
        default=None,
        description=(
            "The updated todo list. "
            "If not provided, returns the current todo list without making changes."
        ),
    )


class SetTodoList(CallableTool2[Params]):
    name: str = "SetTodoList"
    strict: bool = True
    description: str = load_desc(Path(__file__).parent / "set_todo_list.md")
    params: type[Params] = Params

    def __init__(self, runtime: Runtime) -> None:
        super().__init__()
        self._runtime = runtime

    @override
    async def __call__(self, params: Params) -> ToolReturnValue:
        if params.todos is None:
            return self._read_todos()
        return self._write_todos(params.todos)

    # ---- Write mode --------------------------------------------------------

    def _write_todos(self, todos: list[Todo]) -> ToolReturnValue:
        """Persist the todo list and return confirmation."""
        self._save_todos(todos)

        items = [TodoDisplayItem(title=todo.title, status=todo.status) for todo in todos]
        return ToolReturnValue(
            is_error=False,
            output="Todo list updated",
            message="Todo list updated",
            display=[TodoDisplayBlock(items=items)],
        )

    # ---- Read mode ---------------------------------------------------------

    def _read_todos(self) -> ToolReturnValue:
        """Return the current todo list as text output for the model."""
        todos = self._load_todos()
        if not todos:
            return ToolReturnValue(
                is_error=False,
                output="Todo list is empty.",
                message="",
                display=[],
            )

        lines: list[str] = ["Current todo list:"]
        for todo in todos:
            lines.append(f"- [{todo.status}] {todo.title}")
        return ToolReturnValue(
            is_error=False,
            output="\n".join(lines),
            message="",
            display=[],
        )

    # ---- Persistence -------------------------------------------------------

    def _save_todos(self, todos: list[Todo]) -> None:
        """Persist todos to the appropriate state file."""
        items = [TodoItemState(title=t.title, status=t.status) for t in todos]

        if self._runtime.role == "root":
            self._save_root_todos(items)
        else:
            self._save_subagent_todos(items)

    def _load_todos(self) -> list[Todo]:
        """Load todos from the appropriate state file."""
        if self._runtime.role == "root":
            return self._load_root_todos()
        else:
            return self._load_subagent_todos()

    def _save_root_todos(self, items: list[TodoItemState]) -> None:
        session = self._runtime.session
        session.state.todos = items
        session.save_state()

    def _load_root_todos(self) -> list[Todo]:
        from kimi_cli.session_state import load_session_state

        session = self._runtime.session
        fresh = load_session_state(session.dir)
        session.state.todos = fresh.todos
        result: list[Todo] = []
        for t in fresh.todos:
            try:
                result.append(Todo(title=t.title, status=t.status))
            except Exception:
                logger.warning("Skipping malformed todo item in root state: {t}", t=t)
        return result

    def _save_subagent_todos(self, items: list[TodoItemState]) -> None:
        state_file = self._subagent_state_file()
        if state_file is None:
            return
        data = self._read_subagent_state(state_file)
        data["todos"] = [item.model_dump() for item in items]
        self._write_subagent_state(state_file, data)

    def _load_subagent_todos(self) -> list[Todo]:
        state_file = self._subagent_state_file()
        if state_file is None:
            return []
        data = self._read_subagent_state(state_file)
        raw_todos_val = data.get("todos", [])
        raw_todos = cast(list[Any], raw_todos_val) if isinstance(raw_todos_val, list) else []
        result: list[Todo] = []
        for item in raw_todos:
            try:
                result.append(Todo(**item))
            except Exception:
                logger.warning("Skipping malformed todo item in subagent state: {item}", item=item)
        return result

    def _subagent_state_file(self) -> Path | None:
        store = self._runtime.subagent_store
        agent_id = self._runtime.subagent_id
        if store is None or agent_id is None:
            return None
        return store.instance_dir(agent_id) / "state.json"

    @staticmethod
    def _read_subagent_state(path: Path) -> dict[str, Any]:
        if not path.exists():
            return {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
            logger.warning("Corrupted subagent todo state, using defaults: {path}", path=path)
            return {}
        if not isinstance(data, dict):
            logger.warning("Invalid subagent todo state type, using defaults: {path}", path=path)
            return {}
        return cast(dict[str, Any], data)

    @staticmethod
    def _write_subagent_state(path: Path, data: dict[str, Any]) -> None:
        from kimi_cli.utils.io import atomic_json_write

        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_json_write(data, path)
