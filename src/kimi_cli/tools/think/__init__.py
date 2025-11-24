from pathlib import Path
from typing import override

from kosong.tooling import CallableTool2, ToolOk, ToolReturnValue
from pydantic import BaseModel, Field

from kimi_cli.tools.utils import load_desc


class Params(BaseModel):
    thought: str = Field(description=("A thought to think about."))


class Think(CallableTool2[Params]):
    name: str = "Think"
    description: str = load_desc(Path(__file__).parent / "think.md", {})
    params: type[Params] = Params

    @override
    async def __call__(self, params: Params) -> ToolReturnValue:
        return ToolOk(output="", message="Thought logged")
