import asyncio
from pathlib import Path
from typing import override

from kosong.tooling import CallableTool2, ToolError, ToolOk, ToolReturnValue
from pydantic import BaseModel, Field

from kimi_cli.soul import MaxStepsReached, get_wire_or_none, run_soul
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.toolset import get_current_tool_call_or_none
from kimi_cli.tools.utils import load_desc
from kimi_cli.utils.path import next_available_rotation
from kimi_cli.wire import Wire
from kimi_cli.wire.message import (
    ApprovalRequest,
    ApprovalRequestResolved,
    SubagentEvent,
    WireMessage,
)

# Maximum continuation attempts for task summary
MAX_CONTINUE_ATTEMPTS = 1


CONTINUE_PROMPT = """
Your previous response was too brief. Please provide a more comprehensive summary that includes:

1. Specific technical details and implementations
2. Complete code examples if relevant
3. Detailed findings and analysis
4. All important information that should be aware of by the caller
""".strip()


class Params(BaseModel):
    description: str = Field(description="A short (3-5 word) description of the task")
    subagent_name: str = Field(
        description="The name of the specialized subagent to use for this task"
    )
    prompt: str = Field(
        description=(
            "The task for the subagent to perform. "
            "You must provide a detailed prompt with all necessary background information "
            "because the subagent cannot see anything in your context."
        )
    )


class Task(CallableTool2[Params]):
    name: str = "Task"
    params: type[Params] = Params

    def __init__(self, runtime: Runtime):
        super().__init__(
            description=load_desc(
                Path(__file__).parent / "task.md",
                {
                    "SUBAGENTS_MD": "\n".join(
                        f"- `{name}`: {desc}"
                        for name, desc in runtime.labor_market.fixed_subagent_descs.items()
                    ),
                },
            ),
        )
        self._labor_market = runtime.labor_market
        self._session = runtime.session

    async def _get_subagent_context_file(self) -> Path:
        """Generate a unique context file path for subagent."""
        main_context_file = self._session.context_file
        subagent_base_name = f"{main_context_file.stem}_sub"
        main_context_file.parent.mkdir(parents=True, exist_ok=True)  # just in case
        sub_context_file = await next_available_rotation(
            main_context_file.parent / f"{subagent_base_name}{main_context_file.suffix}"
        )
        assert sub_context_file is not None
        return sub_context_file

    @override
    async def __call__(self, params: Params) -> ToolReturnValue:
        subagents = self._labor_market.subagents

        if params.subagent_name not in subagents:
            return ToolError(
                message=f"Subagent not found: {params.subagent_name}",
                brief="Subagent not found",
            )
        agent = subagents[params.subagent_name]
        try:
            result = await self._run_subagent(agent, params.prompt)
            return result
        except Exception as e:
            return ToolError(
                message=f"Failed to run subagent: {e}",
                brief="Failed to run subagent",
            )

    async def _run_subagent(self, agent: Agent, prompt: str) -> ToolReturnValue:
        """Run subagent with optional continuation for task summary."""
        super_wire = get_wire_or_none()
        assert super_wire is not None
        current_tool_call = get_current_tool_call_or_none()
        assert current_tool_call is not None
        current_tool_call_id = current_tool_call.id

        def _super_wire_send(msg: WireMessage) -> None:
            if isinstance(msg, ApprovalRequest | ApprovalRequestResolved):
                # ApprovalRequest and ApprovalRequestResolved should be root level Wire messages
                super_wire.soul_side.send(msg)
                return

            event = SubagentEvent(
                task_tool_call_id=current_tool_call_id,
                event=msg,
            )
            super_wire.soul_side.send(event)

        async def _ui_loop_fn(wire: Wire) -> None:
            wire_ui = wire.ui_side(merge=True)
            while True:
                msg = await wire_ui.receive()
                _super_wire_send(msg)

        subagent_context_file = await self._get_subagent_context_file()
        context = Context(file_backend=subagent_context_file)
        soul = KimiSoul(agent, context=context)

        try:
            await run_soul(soul, prompt, _ui_loop_fn, asyncio.Event())
        except MaxStepsReached as e:
            return ToolError(
                message=(
                    f"Max steps {e.n_steps} reached when running subagent. "
                    "Please try splitting the task into smaller subtasks."
                ),
                brief="Max steps reached",
            )

        _error_msg = (
            "The subagent seemed not to run properly. Maybe you have to do the task yourself."
        )

        # Check if the subagent context is valid
        if len(context.history) == 0 or context.history[-1].role != "assistant":
            return ToolError(message=_error_msg, brief="Failed to run subagent")

        final_response = context.history[-1].extract_text(sep="\n")

        # Check if response is too brief, if so, run again with continuation prompt
        n_attempts_remaining = MAX_CONTINUE_ATTEMPTS
        if len(final_response) < 200 and n_attempts_remaining > 0:
            await run_soul(soul, CONTINUE_PROMPT, _ui_loop_fn, asyncio.Event())

            if len(context.history) == 0 or context.history[-1].role != "assistant":
                return ToolError(message=_error_msg, brief="Failed to run subagent")
            final_response = context.history[-1].extract_text(sep="\n")

        return ToolOk(output=final_response)
