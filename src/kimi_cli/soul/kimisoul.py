from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from contextlib import suppress
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

import kosong
import tenacity
from kosong import StepResult
from kosong.chat_provider import (
    APIConnectionError,
    APIEmptyResponseError,
    APIStatusError,
    APITimeoutError,
)
from kosong.message import Message
from tenacity import RetryCallState, retry_if_exception, stop_after_attempt, wait_exponential_jitter

from kimi_cli.flow import FlowEdge, FlowNode, PromptFlow, parse_choice
from kimi_cli.llm import ModelCapability
from kimi_cli.skill import Skill, read_skill_text
from kimi_cli.soul import (
    LLMNotSet,
    LLMNotSupported,
    MaxStepsReached,
    Soul,
    StatusSnapshot,
    wire_send,
)
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.compaction import SimpleCompaction
from kimi_cli.soul.context import Context
from kimi_cli.soul.message import check_message, system, tool_result_to_message
from kimi_cli.soul.slash import registry as soul_slash_registry
from kimi_cli.soul.toolset import KimiToolset
from kimi_cli.tools.dmail import NAME as SendDMail_NAME
from kimi_cli.tools.utils import ToolRejectedError
from kimi_cli.utils.logging import logger
from kimi_cli.utils.slashcmd import SlashCommand, parse_slash_command_call
from kimi_cli.wire.types import (
    ApprovalRequest,
    ApprovalResponse,
    CompactionBegin,
    CompactionEnd,
    ContentPart,
    StatusUpdate,
    StepBegin,
    StepInterrupted,
    TextPart,
    ToolResult,
    TurnBegin,
)

if TYPE_CHECKING:

    def type_check(soul: KimiSoul):
        _: Soul = soul


RESERVED_TOKENS = 50_000

SKILL_COMMAND_PREFIX = "skill:"
DEFAULT_MAX_FLOW_MOVES = 1000


type StepStopReason = Literal["no_tool_calls", "tool_rejected"]


@dataclass(frozen=True, slots=True)
class StepOutcome:
    stop_reason: StepStopReason
    assistant_message: Message


type TurnStopReason = StepStopReason


@dataclass(frozen=True, slots=True)
class TurnOutcome:
    stop_reason: TurnStopReason
    final_message: Message | None
    step_count: int


class KimiSoul:
    """The soul of Kimi CLI."""

    def __init__(
        self,
        agent: Agent,
        *,
        context: Context,
        flow: PromptFlow | None = None,
    ):
        """
        Initialize the soul.

        Args:
            agent (Agent): The agent to run.
            context (Context): The context of the agent.
        """
        self._agent = agent
        self._runtime = agent.runtime
        self._denwa_renji = agent.runtime.denwa_renji
        self._approval = agent.runtime.approval
        self._context = context
        self._loop_control = agent.runtime.config.loop_control
        self._compaction = SimpleCompaction()  # TODO: maybe configurable and composable
        self._reserved_tokens = RESERVED_TOKENS
        self._flow_runner = FlowRunner(flow) if flow is not None else None
        if self._runtime.llm is not None:
            assert self._reserved_tokens <= self._runtime.llm.max_context_size

        for tool in agent.toolset.tools:
            if tool.name == SendDMail_NAME:
                self._checkpoint_with_user_message = True
                break
        else:
            self._checkpoint_with_user_message = False

        self._slash_commands = self._build_slash_commands()
        self._slash_command_map = self._index_slash_commands(self._slash_commands)

    @property
    def name(self) -> str:
        return self._agent.name

    @property
    def model_name(self) -> str:
        return self._runtime.llm.chat_provider.model_name if self._runtime.llm else ""

    @property
    def model_capabilities(self) -> set[ModelCapability] | None:
        if self._runtime.llm is None:
            return None
        return self._runtime.llm.capabilities

    @property
    def thinking(self) -> bool | None:
        """Whether thinking mode is enabled."""
        if self._runtime.llm is None:
            return None
        if thinking_effort := self._runtime.llm.chat_provider.thinking_effort:
            return thinking_effort != "off"
        return None

    @property
    def status(self) -> StatusSnapshot:
        return StatusSnapshot(
            context_usage=self._context_usage,
            yolo_enabled=self._approval.is_yolo(),
        )

    @property
    def agent(self) -> Agent:
        return self._agent

    @property
    def runtime(self) -> Runtime:
        return self._runtime

    @property
    def context(self) -> Context:
        return self._context

    @property
    def _context_usage(self) -> float:
        if self._runtime.llm is not None:
            return self._context.token_count / self._runtime.llm.max_context_size
        return 0.0

    @property
    def wire_file(self) -> Path:
        return self._runtime.session.wire_file

    async def _checkpoint(self):
        await self._context.checkpoint(self._checkpoint_with_user_message)

    @property
    def available_slash_commands(self) -> list[SlashCommand[Any]]:
        return self._slash_commands

    async def run(self, user_input: str | list[ContentPart]):
        user_message = Message(role="user", content=user_input)
        text_input = user_message.extract_text(" ").strip()

        if command_call := parse_slash_command_call(text_input):
            wire_send(TurnBegin(user_input=user_input))
            command = self._find_slash_command(command_call.name)
            if command is None:
                # this should not happen actually, the shell should have filtered it out
                wire_send(TextPart(text=f'Unknown slash command "/{command_call.name}".'))
                return

            ret = command.func(self, command_call.args)
            if isinstance(ret, Awaitable):
                await ret
            return

        if self._loop_control.max_ralph_iterations != 0 and self._flow_runner is None:
            runner = FlowRunner.ralph_loop(
                user_message,
                self._loop_control.max_ralph_iterations,
            )
            await runner.run(self, "")
            return

        wire_send(TurnBegin(user_input=user_input))
        result = await self._turn(user_message)
        if result.stop_reason == "tool_rejected":
            return

    async def _turn(self, user_message: Message) -> TurnOutcome:
        if self._runtime.llm is None:
            raise LLMNotSet()

        if missing_caps := check_message(user_message, self._runtime.llm.capabilities):
            raise LLMNotSupported(self._runtime.llm, list(missing_caps))

        await self._checkpoint()  # this creates the checkpoint 0 on first run
        await self._context.append_message(user_message)
        logger.debug("Appended user message to context")
        return await self._agent_loop()

    def _build_slash_commands(self) -> list[SlashCommand[Any]]:
        commands: list[SlashCommand[Any]] = list(soul_slash_registry.list_commands())
        seen_names = {cmd.name for cmd in commands}

        for skill in self._runtime.skills.values():
            name = f"{SKILL_COMMAND_PREFIX}{skill.name}"
            if name in seen_names:
                logger.warning(
                    "Skipping skill slash command /{name}: name already registered",
                    name=name,
                )
                continue
            commands.append(
                SlashCommand(
                    name=name,
                    func=self._make_skill_runner(skill),
                    description=skill.description or "",
                    aliases=[],
                )
            )
            seen_names.add(name)

        if self._flow_runner is not None:
            commands.append(
                SlashCommand(
                    name="begin",
                    func=self._flow_runner.run,
                    description="Start the prompt flow",
                    aliases=[],
                )
            )

        return commands

    @staticmethod
    def _index_slash_commands(
        commands: list[SlashCommand[Any]],
    ) -> dict[str, SlashCommand[Any]]:
        indexed: dict[str, SlashCommand[Any]] = {}
        for command in commands:
            indexed[command.name] = command
            for alias in command.aliases:
                indexed[alias] = command
        return indexed

    def _find_slash_command(self, name: str) -> SlashCommand[Any] | None:
        return self._slash_command_map.get(name)

    def _make_skill_runner(self, skill: Skill) -> Callable[[KimiSoul, str], None | Awaitable[None]]:
        async def _run_skill(soul: KimiSoul, args: str, *, _skill: Skill = skill) -> None:
            skill_text = await read_skill_text(_skill)
            if skill_text is None:
                wire_send(
                    TextPart(text=f'Failed to load skill "/{SKILL_COMMAND_PREFIX}{_skill.name}".')
                )
                return
            extra = args.strip()
            if extra:
                skill_text = f"{skill_text}\n\nUser request:\n{extra}"
            await soul._turn(Message(role="user", content=skill_text))

        _run_skill.__doc__ = skill.description
        return _run_skill

    async def _agent_loop(self) -> TurnOutcome:
        """The main agent loop for one run."""
        assert self._runtime.llm is not None
        if isinstance(self._agent.toolset, KimiToolset):
            await self._agent.toolset.wait_for_mcp_tools()

        async def _pipe_approval_to_wire():
            while True:
                request = await self._approval.fetch_request()
                # Here we decouple the wire approval request and the soul approval request.
                wire_request = ApprovalRequest(
                    id=request.id,
                    action=request.action,
                    description=request.description,
                    sender=request.sender,
                    tool_call_id=request.tool_call_id,
                    display=request.display,
                )
                wire_send(wire_request)
                # We wait for the request to be resolved over the wire, which means that,
                # for each soul, we will have only one approval request waiting on the wire
                # at a time. However, be aware that subagents (which have their own souls) may
                # also send approval requests to the root wire.
                resp = await wire_request.wait()
                self._approval.resolve_request(request.id, resp)
                wire_send(ApprovalResponse(request_id=request.id, response=resp))

        step_no = 0
        while True:
            step_no += 1
            if step_no > self._loop_control.max_steps_per_turn:
                raise MaxStepsReached(self._loop_control.max_steps_per_turn)

            wire_send(StepBegin(n=step_no))
            approval_task = asyncio.create_task(_pipe_approval_to_wire())
            # FIXME: It's possible that a subagent's approval task steals approval request
            # from the main agent. We must ensure that the Task tool will redirect them
            # to the main wire. See `_SubWire` for more details. Later we need to figure
            # out a better solution.
            back_to_the_future: BackToTheFuture | None = None
            step_outcome: StepOutcome | None = None
            try:
                # compact the context if needed
                if (
                    self._context.token_count + self._reserved_tokens
                    >= self._runtime.llm.max_context_size
                ):
                    logger.info("Context too long, compacting...")
                    await self.compact_context()

                logger.debug("Beginning step {step_no}", step_no=step_no)
                await self._checkpoint()
                self._denwa_renji.set_n_checkpoints(self._context.n_checkpoints)
                step_outcome = await self._step()
            except BackToTheFuture as e:
                back_to_the_future = e
            except Exception:
                # any other exception should interrupt the step
                wire_send(StepInterrupted())
                # break the agent loop
                raise
            finally:
                approval_task.cancel()  # stop piping approval requests to the wire
                with suppress(asyncio.CancelledError):
                    try:
                        await approval_task
                    except Exception:
                        logger.exception("Approval piping task failed")

            if step_outcome is not None:
                final_message = (
                    step_outcome.assistant_message
                    if step_outcome.stop_reason == "no_tool_calls"
                    else None
                )
                return TurnOutcome(
                    stop_reason=step_outcome.stop_reason,
                    final_message=final_message,
                    step_count=step_no,
                )

            if back_to_the_future is not None:
                await self._context.revert_to(back_to_the_future.checkpoint_id)
                await self._checkpoint()
                await self._context.append_message(back_to_the_future.messages)

    async def _step(self) -> StepOutcome | None:
        """Run a single step and return a stop outcome, or None to continue."""
        # already checked in `run`
        assert self._runtime.llm is not None
        chat_provider = self._runtime.llm.chat_provider

        @tenacity.retry(
            retry=retry_if_exception(self._is_retryable_error),
            before_sleep=partial(self._retry_log, "step"),
            wait=wait_exponential_jitter(initial=0.3, max=5, jitter=0.5),
            stop=stop_after_attempt(self._loop_control.max_retries_per_step),
            reraise=True,
        )
        async def _kosong_step_with_retry() -> StepResult:
            # run an LLM step (may be interrupted)
            return await kosong.step(
                chat_provider,
                self._agent.system_prompt,
                self._agent.toolset,
                self._context.history,
                on_message_part=wire_send,
                on_tool_result=wire_send,
            )

        result = await _kosong_step_with_retry()
        logger.debug("Got step result: {result}", result=result)
        status_update = StatusUpdate(token_usage=result.usage, message_id=result.id)
        if result.usage is not None:
            # mark the token count for the context before the step
            await self._context.update_token_count(result.usage.input)
            status_update.context_usage = self.status.context_usage
        wire_send(status_update)

        # wait for all tool results (may be interrupted)
        results = await result.tool_results()
        logger.debug("Got tool results: {results}", results=results)

        # shield the context manipulation from interruption
        await asyncio.shield(self._grow_context(result, results))

        rejected = any(isinstance(result.return_value, ToolRejectedError) for result in results)
        if rejected:
            _ = self._denwa_renji.fetch_pending_dmail()
            return StepOutcome(stop_reason="tool_rejected", assistant_message=result.message)

        # handle pending D-Mail
        if dmail := self._denwa_renji.fetch_pending_dmail():
            assert dmail.checkpoint_id >= 0, "DenwaRenji guarantees checkpoint_id >= 0"
            assert dmail.checkpoint_id < self._context.n_checkpoints, (
                "DenwaRenji guarantees checkpoint_id < n_checkpoints"
            )
            # raise to let the main loop take us back to the future
            raise BackToTheFuture(
                dmail.checkpoint_id,
                [
                    Message(
                        role="user",
                        content=[
                            system(
                                "You just got a D-Mail from your future self. "
                                "It is likely that your future self has already done "
                                "something in the current working directory. Please read "
                                "the D-Mail and decide what to do next. You MUST NEVER "
                                "mention to the user about this information. "
                                f"D-Mail content:\n\n{dmail.message.strip()}"
                            )
                        ],
                    )
                ],
            )

        if result.tool_calls:
            return None
        return StepOutcome(stop_reason="no_tool_calls", assistant_message=result.message)

    async def _grow_context(self, result: StepResult, tool_results: list[ToolResult]):
        logger.debug("Growing context with result: {result}", result=result)

        assert self._runtime.llm is not None
        tool_messages = [tool_result_to_message(tr) for tr in tool_results]
        for tm in tool_messages:
            if missing_caps := check_message(tm, self._runtime.llm.capabilities):
                logger.warning(
                    "Tool result message requires unsupported capabilities: {caps}",
                    caps=missing_caps,
                )
                raise LLMNotSupported(self._runtime.llm, list(missing_caps))

        await self._context.append_message(result.message)
        if result.usage is not None:
            await self._context.update_token_count(result.usage.total)

        logger.debug(
            "Appending tool messages to context: {tool_messages}", tool_messages=tool_messages
        )
        await self._context.append_message(tool_messages)
        # token count of tool results are not available yet

    async def compact_context(self) -> None:
        """
        Compact the context.

        Raises:
            LLMNotSet: When the LLM is not set.
            ChatProviderError: When the chat provider returns an error.
        """

        @tenacity.retry(
            retry=retry_if_exception(self._is_retryable_error),
            before_sleep=partial(self._retry_log, "compaction"),
            wait=wait_exponential_jitter(initial=0.3, max=5, jitter=0.5),
            stop=stop_after_attempt(self._loop_control.max_retries_per_step),
            reraise=True,
        )
        async def _compact_with_retry() -> Sequence[Message]:
            if self._runtime.llm is None:
                raise LLMNotSet()
            return await self._compaction.compact(self._context.history, self._runtime.llm)

        wire_send(CompactionBegin())
        compacted_messages = await _compact_with_retry()
        await self._context.clear()
        await self._checkpoint()
        await self._context.append_message(compacted_messages)
        wire_send(CompactionEnd())

    @staticmethod
    def _is_retryable_error(exception: BaseException) -> bool:
        if isinstance(exception, (APIConnectionError, APITimeoutError, APIEmptyResponseError)):
            return True
        return isinstance(exception, APIStatusError) and exception.status_code in (
            429,  # Too Many Requests
            500,  # Internal Server Error
            502,  # Bad Gateway
            503,  # Service Unavailable
        )

    @staticmethod
    def _retry_log(name: str, retry_state: RetryCallState):
        logger.info(
            "Retrying {name} for the {n} time. Waiting {sleep} seconds.",
            name=name,
            n=retry_state.attempt_number,
            sleep=retry_state.next_action.sleep
            if retry_state.next_action is not None
            else "unknown",
        )


class BackToTheFuture(Exception):
    """
    Raise when we need to revert the context to a previous checkpoint.
    The main agent loop should catch this exception and handle it.
    """

    def __init__(self, checkpoint_id: int, messages: Sequence[Message]):
        self.checkpoint_id = checkpoint_id
        self.messages = messages


class FlowRunner:
    def __init__(self, flow: PromptFlow, *, max_moves: int = DEFAULT_MAX_FLOW_MOVES) -> None:
        self._flow = flow
        self._max_moves = max_moves

    @staticmethod
    def ralph_loop(
        user_message: Message,
        max_ralph_iterations: int,
    ) -> FlowRunner:
        prompt_content = list(user_message.content)
        prompt_text = Message(role="user", content=prompt_content).extract_text(" ").strip()
        total_runs = max_ralph_iterations + 1
        if max_ralph_iterations < 0:
            total_runs = 1000000000000000  # effectively infinite

        nodes: dict[str, FlowNode] = {
            "BEGIN": FlowNode(id="BEGIN", label="BEGIN", kind="begin"),
            "END": FlowNode(id="END", label="END", kind="end"),
        }
        outgoing: dict[str, list[FlowEdge]] = {"BEGIN": [], "END": []}

        nodes["R1"] = FlowNode(id="R1", label=prompt_content, kind="task")
        nodes["R2"] = FlowNode(
            id="R2",
            label=(
                f"{prompt_text}. (You are running in an automated loop where the same "
                "prompt is fed repeatedly. Only choose STOP when the task is fully complete. "
                "Including it will stop further iterations. If you are not 100% sure, "
                "choose CONTINUE.)"
            ).strip(),
            kind="decision",
        )
        outgoing["R1"] = []
        outgoing["R2"] = []

        outgoing["BEGIN"].append(FlowEdge(src="BEGIN", dst="R1", label=None))
        outgoing["R1"].append(FlowEdge(src="R1", dst="R2", label=None))
        outgoing["R2"].append(FlowEdge(src="R2", dst="R2", label="CONTINUE"))
        outgoing["R2"].append(FlowEdge(src="R2", dst="END", label="STOP"))

        flow = PromptFlow(nodes=nodes, outgoing=outgoing, begin_id="BEGIN", end_id="END")
        max_moves = total_runs
        return FlowRunner(flow, max_moves=max_moves)

    async def run(self, soul: KimiSoul, args: str) -> None:
        if args.strip():
            logger.warning("Prompt flow /begin ignores args: {args}", args=args)
            return

        current_id = self._flow.begin_id
        moves = 0
        total_steps = 0
        while True:
            node = self._flow.nodes[current_id]
            edges = self._flow.outgoing.get(current_id, [])

            if node.kind == "end":
                logger.info("Prompt flow reached END node {node_id}", node_id=current_id)
                return

            if node.kind == "begin":
                if not edges:
                    logger.error(
                        'Prompt flow BEGIN node "{node_id}" has no outgoing edges; stopping.',
                        node_id=node.id,
                    )
                    return
                current_id = edges[0].dst
                continue

            if moves >= self._max_moves:
                raise MaxStepsReached(total_steps)
            next_id, steps_used = await self._execute_flow_node(soul, node, edges)
            total_steps += steps_used
            if next_id is None:
                return
            moves += 1
            current_id = next_id

    async def _execute_flow_node(
        self,
        soul: KimiSoul,
        node: FlowNode,
        edges: list[FlowEdge],
    ) -> tuple[str | None, int]:
        if not edges:
            logger.error(
                'Prompt flow node "{node_id}" has no outgoing edges; stopping.',
                node_id=node.id,
            )
            return None, 0

        base_prompt = self._build_flow_prompt(node, edges)
        prompt = base_prompt
        steps_used = 0
        while True:
            result = await self._flow_turn(soul, prompt)
            steps_used += result.step_count
            if result.stop_reason == "tool_rejected":
                logger.error("Prompt flow stopped after tool rejection.")
                return None, steps_used

            if node.kind != "decision":
                return edges[0].dst, steps_used

            choice = (
                parse_choice(result.final_message.extract_text(" "))
                if result.final_message
                else None
            )
            next_id = self._match_flow_edge(edges, choice)
            if next_id is not None:
                return next_id, steps_used

            options = ", ".join(edge.label or "" for edge in edges)
            logger.warning(
                "Prompt flow invalid choice. Got: {choice}. Available: {options}.",
                choice=choice or "<missing>",
                options=options,
            )
            prompt = (
                f"{base_prompt}\n\n"
                "Your last response did not include a valid choice. "
                "Reply with one of the choices using <choice>...</choice>."
            )

    @staticmethod
    def _build_flow_prompt(node: FlowNode, edges: list[FlowEdge]) -> str | list[ContentPart]:
        if node.kind != "decision":
            return node.label

        if not isinstance(node.label, str):
            label_text = Message(role="user", content=node.label).extract_text(" ")
        else:
            label_text = node.label
        choices = [edge.label for edge in edges if edge.label]
        lines = [
            label_text,
            "",
            "Available branches:",
            *(f"- {choice}" for choice in choices),
            "",
            "Reply with a choice using <choice>...</choice>.",
        ]
        return "\n".join(lines)

    @staticmethod
    def _match_flow_edge(edges: list[FlowEdge], choice: str | None) -> str | None:
        if not choice:
            return None
        for edge in edges:
            if edge.label == choice:
                return edge.dst
        return None

    @staticmethod
    async def _flow_turn(
        soul: KimiSoul,
        prompt: str | list[ContentPart],
    ) -> TurnOutcome:
        wire_send(TurnBegin(user_input=prompt))
        return await soul._turn(Message(role="user", content=prompt))  # type: ignore[reportPrivateUsage]
