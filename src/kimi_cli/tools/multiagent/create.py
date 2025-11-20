from pathlib import Path
from typing import Any

from kosong.tooling import CallableTool2, ToolError, ToolOk, ToolReturnType, Toolset
from pydantic import BaseModel, Field

from kimi_cli.soul.agent import Agent, LaborMarket, Runtime
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

    def __init__(
        self, labor_market: LaborMarket, toolset: Toolset, runtime: Runtime, **kwargs: Any
    ):
        super().__init__(**kwargs)
        self._labor_market = labor_market
        self._toolset = toolset
        self._runtime = runtime

    async def __call__(self, params: Params) -> ToolReturnType:
        if params.name in self._labor_market.subagents:
            return ToolError(
                message=f"Subagent with name '{params.name}' already exists.",
                brief="Subagent already exists",
            )

        subagent = Agent(
            name=params.name,
            system_prompt=params.system_prompt,
            toolset=self._toolset,
            runtime=self._runtime.copy_for_subagent(),
        )
        self._labor_market.add_dynamic_subagent(params.name, subagent)
        return ToolOk(
            output="Available subagents: " + ", ".join(self._labor_market.subagents.keys()),
            message=f"Subagent '{params.name}' created successfully.",
        )
