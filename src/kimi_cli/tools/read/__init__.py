import asyncio
from pathlib import Path
from typing import override

from kosong.base.message import TextPart
from kosong.tooling import CallableTool2, ToolError, ToolOk, ToolReturnType
from pydantic import BaseModel, Field

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

MAX_CONTINUE_ATTEMPTS = 1

CONTINUE_PROMPT = """
Your previous response was too brief. Please provide a richer summary that:

1. Lists each relevant file you inspected, with short rationale.
2. Includes key snippets or line references when possible.
3. Explains how the gathered context helps with the caller's objective.
""".strip()


class Params(BaseModel):
    description: str = Field(
        description=(
            "Detailed description of what information the caller needs. "
            "Include the broader task so the reader knows why the context matters."
        )
    )


class ReadContext(CallableTool2[Params]):
    name: str = "ReadContext"
    description: str = load_desc(Path(__file__).parent / "read.md")
    params: type[Params] = Params

    def __init__(self, runtime: Runtime, **kwargs):
        super().__init__(**kwargs)
        self._runtime = runtime
        self._agent_path = Path(__file__).parent / "agent.yaml"
        self._agent: Agent | None = None
        self._load_task: asyncio.Task[None] | None = None
        self._color_prefix = "\x1b[36;1m"
        self._color_reset = "\x1b[0m"
        self._label_emitted = False
        try:
            loop = asyncio.get_running_loop()
            self._load_task = loop.create_task(self._load_agent())
        except RuntimeError:
            asyncio.run(self._load_agent())
            self._load_task = None

    async def _load_agent(self) -> None:
        agent = await load_agent(self._agent_path, self._runtime, mcp_configs=[])
        self._agent = agent

    async def _ensure_agent_loaded(self) -> Agent:
        if self._load_task is not None:
            await self._load_task
            self._load_task = None
        if self._agent is None:
            await self._load_agent()
        assert self._agent is not None
        return self._agent

    async def _get_history_file(self) -> Path:
        session = self._runtime.session
        history_file = session.history_file
        base_name = f"{history_file.stem}_read"
        history_file.parent.mkdir(parents=True, exist_ok=True)
        result = await next_available_rotation(history_file.parent / f"{base_name}{history_file.suffix}")
        assert result is not None
        return result

    def _format_text(self, text: str) -> str:
        return text

    def _format_banner(self, message: str) -> str:
        return f"\n{self._color_prefix}[ContextReader] {message}{self._color_reset}"

    def _send_banner(self, wire, message: str, *, blank_after: bool = False) -> None:
        suffix = "\n\n" if blank_after else "\n"
        wire.soul_side.send(TextPart(text=self._format_banner(message) + suffix))

    def _build_prompt(self, params: Params) -> str:
        sections: list[str] = [
            "You are assisting the main agent by gathering project context.",
            "Objective:",
            params.description.strip(),
        ]
        sections.append(
            "Deliver a structured report that lists inspected files, cites paths and relevant snippets, "
            "and ends with a concise explanation of how the findings support the objective."
        )
        sections.append("Call out any missing information or follow-up work that might be required.")
        return "\n\n".join(sections)

    @override
    async def __call__(self, params: Params) -> ToolReturnType:
        agent = await self._ensure_agent_loaded()
        prompt = self._build_prompt(params)
        return await self._run_reader(agent, prompt)

    async def _run_reader(self, agent: Agent, prompt: str) -> ToolReturnType:
        super_wire = get_wire_or_none()
        assert super_wire is not None
        self._label_emitted = False

        def _super_wire_send(msg: WireMessage) -> None:
            if isinstance(msg, ApprovalRequest):
                self._send_banner(super_wire, f"requests approval: {msg.description}")
                super_wire.soul_side.send(msg)
                return
            if isinstance(msg, TextPart):
                text = self._format_text(msg.text)
                if text:
                    if not self._label_emitted:
                        self._send_banner(super_wire, "⇢ context reader output", blank_after=True)
                        self._label_emitted = True
                msg = TextPart(text=text)
            super_wire.soul_side.send(msg)

        async def _ui_loop_fn(wire: WireUISide) -> None:
            while True:
                msg = await wire.receive()
                _super_wire_send(msg)

        history_file = await self._get_history_file()
        self._send_banner(
            super_wire,
            f"⇢ gathering context (log: {history_file.name})",
            blank_after=True,
        )
        context = Context(file_backend=history_file)
        soul = KimiSoul(agent, runtime=self._runtime, context=context)

        try:
            try:
                await run_soul(soul, prompt, _ui_loop_fn, asyncio.Event())
            except MaxStepsReached as e:
                return ToolError(
                    message=(
                        f"Max steps {e.n_steps} reached while gathering context. "
                        "Try narrowing the scope or providing more specific hints."
                    ),
                    brief="Max steps reached",
                )

            if not context.history or context.history[-1].role != "assistant":
                return ToolError(
                    message="The reading agent did not produce a final response.",
                    brief="Failed to gather context",
                )

            final_response = message_extract_text(context.history[-1])
            if len(final_response) < 200 and MAX_CONTINUE_ATTEMPTS > 0:
                self._send_banner(super_wire, "⇢ refining context summary")
                try:
                    await run_soul(soul, CONTINUE_PROMPT, _ui_loop_fn, asyncio.Event())
                except MaxStepsReached as e:
                    return ToolError(
                        message=(
                            f"Max steps {e.n_steps} reached while refining the context summary. "
                            "Try providing more specific guidance to the reader."
                        ),
                        brief="Max steps reached",
                    )
                if not context.history or context.history[-1].role != "assistant":
                    return ToolError(
                        message="The reading agent failed to complete the summary.",
                        brief="Incomplete summary",
                    )
                final_response = message_extract_text(context.history[-1])

            history_note = f"Context gathered successfully. Transcript saved to: {history_file}"
            return ToolOk(output=final_response, message=history_note)
        finally:
            self._label_emitted = False
            self._send_banner(super_wire, "⇠ context reader finished")
