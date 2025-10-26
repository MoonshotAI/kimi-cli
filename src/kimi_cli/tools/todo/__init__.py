from pathlib import Path
from typing import Literal, override

from kosong.tooling import CallableTool2, ToolOk, ToolReturnType
from pydantic import BaseModel, Field


class Todo(BaseModel):
    title: str = Field(description="The title of the todo", min_length=1)
    status: Literal["Pending", "In Progress", "Done"] = Field(description="The status of the todo")


class Params(BaseModel):
    todos: list[Todo] = Field(description="The updated todo list")


class SetTodoList(CallableTool2[Params]):
    name: str = "SetTodoList"
    description: str = (Path(__file__).parent / "set_todo_list.md").read_text(encoding="utf-8")
    params: type[Params] = Params

    @override
    async def __call__(self, params: Params) -> ToolReturnType:
        rendered = ""
        for todo in params.todos:
            rendered += f"- {todo.title} [{todo.status}]\n"
        return ToolOk(output=rendered)
