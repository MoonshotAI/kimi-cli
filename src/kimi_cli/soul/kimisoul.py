import asyncio
from collections.abc import Sequence
from functools import partial
from typing import TYPE_CHECKING

import kosong
import tenacity
from kosong import StepResult
from kosong.base.chat_provider import ThinkingEffort
from kosong.base.message import ContentPart, ImageURLPart, Message
from kosong.chat_provider import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    ChatProviderError,
)
from kosong.tooling import ToolResult
from tenacity import RetryCallState, retry_if_exception, stop_after_attempt, wait_exponential_jitter

from kimi_cli.llm import ModelCapability
from kimi_cli.soul import (
    LLMNotSet,
    LLMNotSupported,
    MaxStepsReached,
    Soul,
    StatusSnapshot,
    wire_send,
)
from kimi_cli.soul.agent import Agent
from kimi_cli.soul.compaction import SimpleCompaction
from kimi_cli.soul.context import Context
from kimi_cli.soul.message import system, tool_result_to_messages
from kimi_cli.soul.runtime import Runtime
from kimi_cli.tools.dmail import NAME as SendDMail_NAME
from kimi_cli.tools.utils import ToolRejectedError
from kimi_cli.utils.logging import logger
from kimi_cli.wire.message import (
    CompactionBegin,
    CompactionEnd,
    StatusUpdate,
    StepBegin,
    StepInterrupted,
)

RESERVED_TOKENS = 50_000


class KimiSoul(Soul):
    """The soul of Kimi CLI."""

    def __init__(
        self,
        agent: Agent,
        runtime: Runtime,
        *,
        context: Context,
    ):
        """
        Initialize the soul.

        Args:
            agent (Agent): The agent to run.
            runtime (Runtime): Runtime parameters and states.
            context (Context): The context of the agent.
        """
        self._agent = agent
        self._runtime = runtime
        self._denwa_renji = runtime.denwa_renji
        self._approval = runtime.approval
        self._context = context
        self._loop_control = runtime.config.loop_control
        self._compaction = SimpleCompaction()  # TODO: maybe configurable and composable
        self._reserved_tokens = RESERVED_TOKENS
        if self._runtime.llm is not None:
            assert self._reserved_tokens <= self._runtime.llm.max_context_size
        self._thinking_effort: ThinkingEffort = "off"

        for tool in agent.toolset.tools:
            if tool.name == SendDMail_NAME:
                self._checkpoint_with_user_message = True
                break
        else:
            self._checkpoint_with_user_message = False

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
    def status(self) -> StatusSnapshot:
        return StatusSnapshot(context_usage=self._context_usage)

    @property
    def context(self) -> Context:
        return self._context

    @property
    def _context_usage(self) -> float:
        if self._runtime.llm is not None:
            return self._context.token_count / self._runtime.llm.max_context_size
        return 0.0

    def set_thinking(self, enabled: bool) -> None:
        """
        Enable/disable thinking mode for the soul.

        Raises:
            LLMNotSet: When the LLM is not set.
            LLMNotSupported: When the LLM does not support thinking mode.
        """
        if self._runtime.llm is None:
            raise LLMNotSet()
        if enabled and "thinking" not in self._runtime.llm.capabilities:
            raise LLMNotSupported(self._runtime.llm, ["thinking"])
        self._thinking_effort = "high" if enabled else "off"

    async def _checkpoint(self):
        await self._context.checkpoint(self._checkpoint_with_user_message)

    async def run(self, user_input: str | list[ContentPart]):
        if self._runtime.llm is None:
            raise LLMNotSet()

        if (
            isinstance(user_input, list)
            and any(isinstance(part, ImageURLPart) for part in user_input)
            and "image_in" not in self._runtime.llm.capabilities
        ):
            raise LLMNotSupported(self._runtime.llm, ["image_in"])

        await self._checkpoint()  # this creates the checkpoint 0 on first run
        await self._context.append_message(Message(role="user", content=user_input))
        logger.debug("Appended user message to context")
        await self._agent_loop()

    async def _agent_loop(self):
        """The main agent loop for one run."""
        assert self._runtime.llm is not None

        async def _pipe_approval_to_wire():
            while True:
                request = await self._approval.fetch_request()
                wire_send(request)

        step_no = 1
        while True:
            wire_send(StepBegin(step_no))
            approval_task = asyncio.create_task(_pipe_approval_to_wire())
            # FIXME: It's possible that a subagent's approval task steals approval request
            # from the main agent. We must ensure that the Task tool will redirect them
            # to the main wire. See `_SubWire` for more details. Later we need to figure
            # out a better solution.
            try:
                # compact the context if needed
                if (
                    self._context.token_count + self._reserved_tokens
                    >= self._runtime.llm.max_context_size
                ):
                    logger.info("Context too long, compacting...")
                    wire_send(CompactionBegin())
                    await self.compact_context()
                    wire_send(CompactionEnd())

                logger.debug("Beginning step {step_no}", step_no=step_no)
                await self._checkpoint()
                self._denwa_renji.set_n_checkpoints(self._context.n_checkpoints)
                finished = await self._step()
            except BackToTheFuture as e:
                await self._context.revert_to(e.checkpoint_id)
                await self._checkpoint()
                await self._context.append_message(e.messages)
                continue
            except (ChatProviderError, asyncio.CancelledError):
                wire_send(StepInterrupted())
                # break the agent loop
                raise
            finally:
                approval_task.cancel()  # stop piping approval requests to the wire

            if finished:
                return

            step_no += 1
            if step_no > self._loop_control.max_steps_per_run:
                raise MaxStepsReached(self._loop_control.max_steps_per_run)

    async def _step(self) -> bool:
        """Run an single step and return whether the run should be stopped."""
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
                chat_provider.with_thinking(self._thinking_effort),
                self._agent.system_prompt,
                self._agent.toolset,
                self._context.history,
                on_message_part=wire_send,
                on_tool_result=wire_send,
            )

        result = await _kosong_step_with_retry()
        logger.debug("Got step result: {result}", result=result)
        if result.usage is not None:
            # mark the token count for the context before the step
            await self._context.update_token_count(result.usage.input)
            wire_send(StatusUpdate(status=self.status))

        # wait for all tool results (may be interrupted)
        results = await result.tool_results()
        logger.debug("Got tool results: {results}", results=results)

        # shield the context manipulation from interruption
        await asyncio.shield(self._grow_context(result, results))

        rejected = any(isinstance(result.result, ToolRejectedError) for result in results)
        if rejected:
            _ = self._denwa_renji.fetch_pending_dmail()
            return True

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

        return not result.tool_calls

    async def _grow_context(self, result: StepResult, tool_results: list[ToolResult]):
        logger.debug("Growing context with result: {result}", result=result)
        await self._context.append_message(result.message)
        if result.usage is not None:
            await self._context.update_token_count(result.usage.total)

        # token count of tool results are not available yet
        for tool_result in tool_results:
            logger.debug("Appending tool result to context: {tool_result}", tool_result=tool_result)
            await self._context.append_message(tool_result_to_messages(tool_result))

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

        compacted_messages = await _compact_with_retry()
        await self._context.revert_to(0)
        await self._checkpoint()
        await self._context.append_message(compacted_messages)

    @staticmethod
    def _is_retryable_error(exception: BaseException) -> bool:
        if isinstance(exception, (APIConnectionError, APITimeoutError)):
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


if TYPE_CHECKING:

    def type_check(kimi_soul: KimiSoul):
        _: Soul = kimi_soul
