from pathlib import Path
from typing import Any

from kosong.tooling import CallableTool2, ToolError, ToolOk, ToolReturnType
from pydantic import BaseModel, Field

from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.toolset import KimiToolset
from kimi_cli.tools.utils import load_desc


class Params(BaseModel):
    name: str = Field(
        description=(
            "Unique name for this agent configuration (e.g., 'summarizer', 'code_reviewer'). "
            "This name will be used to reference the agent in the Task tool."
        )
    )
    system_prompt: str = Field(
        description="System prompt defining the agent's role, capabilities, and boundaries."
    )


class CreateSubagent(CallableTool2[Params]):
    name: str = "CreateSubagent"
    description: str = load_desc(Path(__file__).parent / "create.md")
    params: type[Params] = Params

    def __init__(self, toolset: KimiToolset, runtime: Runtime, **kwargs: Any):
        super().__init__(**kwargs)
        self._toolset = toolset
        self._runtime = runtime

    async def __call__(self, params: Params) -> ToolReturnType:
        if params.name in self._runtime.labor_market.subagents:
            return ToolError(
                message=f"Subagent with name '{params.name}' already exists.",
                brief="Subagent already exists",
            )

        subagent = Agent(
            name=params.name,
            system_prompt=params.system_prompt,
            toolset=self._toolset,  # share the same toolset as the parent agent
            runtime=self._runtime.copy_for_dynamic_subagent(),
        )
        self._runtime.labor_market.add_dynamic_subagent(params.name, subagent)
        return ToolOk(
            output="Available subagents: " + ", ".join(self._runtime.labor_market.subagents.keys()),
            message=f"Subagent '{params.name}' created successfully.",
        )
