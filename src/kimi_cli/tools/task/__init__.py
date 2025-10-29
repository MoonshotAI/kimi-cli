import asyncio
from pathlib import Path
from typing import override

from kosong.tooling import CallableTool2, ToolError, ToolOk, ToolReturnType
from pydantic import BaseModel, Field

from kimi_cli.agentspec import ResolvedAgentSpec, SubagentSpec
from kimi_cli.soul import MaxStepsReached, get_wire_or_none, run_soul
from kimi_cli.soul.agent import Agent, load_agent
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.runtime import Runtime
from kimi_cli.tools.utils import load_desc
from kimi_cli.utils.message import message_extract_text
from kimi_cli.utils.path import next_available_rotation
from kimi_cli.wire import WireUISide
from kimi_cli.wire.message import ApprovalRequest, WireMessage

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

    def __init__(self, agent_spec: ResolvedAgentSpec, runtime: Runtime, **kwargs):
        super().__init__(
            description=load_desc(
                Path(__file__).parent / "task.md",
                {
                    "SUBAGENTS_MD": "\n".join(
                        f"- `{name}`: {spec.description}"
                        for name, spec in agent_spec.subagents.items()
                    ),
                },
            ),
            **kwargs,
        )

        self._runtime = runtime
        self._session = runtime.session
        self._subagents: dict[str, Agent] = {}

        try:
            loop = asyncio.get_running_loop()
            self._load_task = loop.create_task(self._load_subagents(agent_spec.subagents))
        except RuntimeError:
            # In case there's no running event loop, e.g., during synchronous tests
            self._load_task = None
            asyncio.run(self._load_subagents(agent_spec.subagents))

    async def _load_subagents(self, subagent_specs: dict[str, SubagentSpec]) -> None:
        """Load all subagents specified in the agent spec."""
        for name, spec in subagent_specs.items():
            agent = await load_agent(spec.path, self._runtime, mcp_configs=[])
            self._subagents[name] = agent

    async def _get_subagent_history_file(self) -> Path:
        """Generate a unique history file path for subagent."""
        main_history_file = self._session.history_file
        subagent_base_name = f"{main_history_file.stem}_sub"
        main_history_file.parent.mkdir(parents=True, exist_ok=True)  # just in case
        sub_history_file = await next_available_rotation(
            main_history_file.parent / f"{subagent_base_name}{main_history_file.suffix}"
        )
        assert sub_history_file is not None
        return sub_history_file

    @override
    async def __call__(self, params: Params) -> ToolReturnType:
        if self._load_task is not None:
            await self._load_task
            self._load_task = None

        if params.subagent_name not in self._subagents:
            return ToolError(
                message=f"Subagent not found: {params.subagent_name}",
                brief="Subagent not found",
            )
        agent = self._subagents[params.subagent_name]
        try:
            result = await self._run_subagent(agent, params.prompt)
            return result
        except Exception as e:
            return ToolError(
                message=f"Failed to run subagent: {e}",
                brief="Failed to run subagent",
            )

    async def _run_subagent(self, agent: Agent, prompt: str) -> ToolReturnType:
        """Run subagent with optional continuation for task summary."""
        super_wire = get_wire_or_none()
        assert super_wire is not None

        def _super_wire_send(msg: WireMessage) -> None:
            if isinstance(msg, ApprovalRequest):
                super_wire.soul_side.send(msg)
            # TODO: visualize subagent behavior by sending other messages in some way

        async def _ui_loop_fn(wire: WireUISide) -> None:
            while True:
                msg = await wire.receive()
                _super_wire_send(msg)

        subagent_history_file = await self._get_subagent_history_file()
        context = Context(file_backend=subagent_history_file)
        soul = KimiSoul(agent, runtime=self._runtime, context=context)

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

        final_response = message_extract_text(context.history[-1])

        # Check if response is too brief, if so, run again with continuation prompt
        n_attempts_remaining = MAX_CONTINUE_ATTEMPTS
        if len(final_response) < 200 and n_attempts_remaining > 0:
            await run_soul(soul, CONTINUE_PROMPT, _ui_loop_fn, asyncio.Event())

            if len(context.history) == 0 or context.history[-1].role != "assistant":
                return ToolError(message=_error_msg, brief="Failed to run subagent")
            final_response = message_extract_text(context.history[-1])

        return ToolOk(output=final_response)
