from kosong.tooling import CallableTool2, ToolError, ToolOk, ToolReturnValue
from pydantic import BaseModel, Field


class Params(BaseModel):
    directory: str = Field(description="The directory to list files from.", default=".")


class Ls(CallableTool2):
    name: str = "Ls"
    description: str = "List files in a directory."
    params: type[Params] = Params

    async def __call__(self, params: Params) -> ToolReturnValue:
        import os

        try:
            files = os.listdir(params.directory)
            output = "\n".join(files)
            return ToolOk(output=output)
        except Exception as e:
            return ToolError(
                output="",
                message=str(e),
                brief="Failed to list files",
            )
