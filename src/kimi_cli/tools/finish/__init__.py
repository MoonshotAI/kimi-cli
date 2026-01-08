from pathlib import Path
from typing import override

from kosong.tooling import CallableTool2, ToolOk, ToolReturnValue
from pydantic import BaseModel

from kimi_cli.tools.utils import load_desc


class Params(BaseModel):
    pass


class Finish(CallableTool2[Params]):
    name: str = "Finish"
    description: str = load_desc(Path(__file__).parent / "finish.md", {})
    params: type[Params] = Params

    @override
    async def __call__(self, params: Params) -> ToolReturnValue:
        return ToolOk(output="Task finished", message="Task completed successfully")
