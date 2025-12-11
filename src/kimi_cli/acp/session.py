from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncGenerator, Callable

import acp
import streamingjson  # pyright: ignore[reportMissingTypeStubs]
from kosong.chat_provider import ChatProviderError
from kosong.message import ContentPart, TextPart, ThinkPart, ToolCall, ToolCallPart
from kosong.tooling import ToolError, ToolResult

from kimi_cli.acp.convert import acp_blocks_to_content_parts, tool_result_to_acp_content
from kimi_cli.acp.types import ACPContentBlock
from kimi_cli.soul import LLMNotSet, LLMNotSupported, MaxStepsReached, RunCancelled
from kimi_cli.tools import extract_key_argument
from kimi_cli.utils.logging import logger
from kimi_cli.wire.message import (
    ApprovalRequest,
    ApprovalRequestResolved,
    CompactionBegin,
    CompactionEnd,
    StatusUpdate,
    StepBegin,
    StepInterrupted,
    SubagentEvent,
    TurnBegin,
    WireMessage,
)


class _ToolCallState:
    """Manages the state of a single tool call for streaming updates."""

    def __init__(self, tool_call: ToolCall):
        # When the user rejected or cancelled a tool call, the step result may not
        # be appended to the context. In this case, future step may emit tool call
        # with the same tool call ID (on the LLM side). To avoid confusion of the
        # ACP client, we need to ensure the uniqueness in the ACP connection.
        self.acp_tool_call_id = str(uuid.uuid4())

        self.tool_call = tool_call
        self.args = tool_call.function.arguments or ""
        self.lexer = streamingjson.Lexer()
        if tool_call.function.arguments is not None:
            self.lexer.append_string(tool_call.function.arguments)

    def append_args_part(self, args_part: str):
        """Append a new arguments part to the accumulated args and lexer."""
        self.args += args_part
        self.lexer.append_string(args_part)

    def get_title(self) -> str:
        """Get the current title with subtitle if available."""
        tool_name = self.tool_call.function.name
        subtitle = extract_key_argument(self.lexer, tool_name)
        if subtitle:
            return f"{tool_name}: {subtitle}"
        return tool_name


class _RunState:
    def __init__(self):
        self.tool_calls: dict[str, _ToolCallState] = {}
        """Map of tool call ID (LLM-side ID) to tool call state."""
        self.last_tool_call: _ToolCallState | None = None
        self.cancel_event = asyncio.Event()


class ACPSession:
    def __init__(
        self,
        id: str,
        prompt_fn: Callable[[list[ContentPart], asyncio.Event], AsyncGenerator[WireMessage]],
        acp_conn: acp.Client,
    ) -> None:
        self._id = id
        self._prompt_fn = prompt_fn
        self._conn = acp_conn
        self._run_state: _RunState | None = None

    @property
    def id(self) -> str:
        return self._id

    async def prompt(self, prompt: list[ACPContentBlock]) -> acp.PromptResponse:
        user_input = acp_blocks_to_content_parts(prompt)
        self._run_state = _RunState()
        try:
            async for msg in self._prompt_fn(user_input, self._run_state.cancel_event):
                match msg:
                    case TurnBegin():
                        pass
                    case StepBegin():
                        pass
                    case StepInterrupted():
                        break
                    case CompactionBegin():
                        pass
                    case CompactionEnd():
                        pass
                    case StatusUpdate():
                        pass
                    case ThinkPart(think=think):
                        await self._send_thinking(think)
                    case TextPart(text=text):
                        await self._send_text(text)
                    case ContentPart():
                        logger.warning("Unsupported content part: {part}", part=msg)
                        await self._send_text(f"[{msg.__class__.__name__}]")
                    case ToolCall():
                        await self._send_tool_call(msg)
                    case ToolCallPart():
                        await self._send_tool_call_part(msg)
                    case ToolResult():
                        await self._send_tool_result(msg)
                    case SubagentEvent():
                        pass
                    case ApprovalRequestResolved():
                        pass
                    case ApprovalRequest():
                        await self._handle_approval_request(msg)
        except LLMNotSet as e:
            logger.exception("LLM not set:")
            raise acp.RequestError.internal_error({"error": str(e)}) from e
        except LLMNotSupported as e:
            logger.exception("LLM not supported:")
            raise acp.RequestError.internal_error({"error": str(e)}) from e
        except ChatProviderError as e:
            logger.exception("LLM provider error:")
            raise acp.RequestError.internal_error({"error": str(e)}) from e
        except MaxStepsReached as e:
            logger.warning("Max steps reached: {n_steps}", n_steps=e.n_steps)
            return acp.PromptResponse(stop_reason="max_turn_requests")
        except RunCancelled:
            logger.info("Prompt cancelled by user")
            return acp.PromptResponse(stop_reason="cancelled")
        except Exception as e:
            logger.exception("Unexpected error during prompt:")
            raise acp.RequestError.internal_error({"error": str(e)}) from e
        finally:
            self._run_state = None
        return acp.PromptResponse(stop_reason="end_turn")

    async def cancel(self) -> None:
        if self._run_state is None:
            logger.warning("Cancel requested but no prompt is running")
            return

        self._run_state.cancel_event.set()

    async def _send_thinking(self, think: str):
        """Send thinking content to client."""
        if not self._id or not self._conn:
            return

        await self._conn.session_update(
            self._id,
            acp.schema.AgentThoughtChunk(
                content=acp.schema.TextContentBlock(type="text", text=think),
                session_update="agent_thought_chunk",
            ),
        )

    async def _send_text(self, text: str):
        """Send text chunk to client."""
        if not self._id or not self._conn:
            return

        await self._conn.session_update(
            session_id=self._id,
            update=acp.schema.AgentMessageChunk(
                content=acp.schema.TextContentBlock(type="text", text=text),
                session_update="agent_message_chunk",
            ),
        )

    async def _send_tool_call(self, tool_call: ToolCall):
        """Send tool call to client."""
        assert self._run_state is not None
        if not self._id or not self._conn:
            return

        # Create and store tool call state
        state = _ToolCallState(tool_call)
        self._run_state.tool_calls[tool_call.id] = state
        self._run_state.last_tool_call = state

        await self._conn.session_update(
            session_id=self._id,
            update=acp.schema.ToolCallStart(
                session_update="tool_call",
                tool_call_id=state.acp_tool_call_id,
                title=state.get_title(),
                status="in_progress",
                content=[
                    acp.schema.ContentToolCallContent(
                        type="content",
                        content=acp.schema.TextContentBlock(type="text", text=state.args),
                    )
                ],
            ),
        )
        logger.debug("Sent tool call: {name}", name=tool_call.function.name)

    async def _send_tool_call_part(self, part: ToolCallPart):
        """Send tool call part (streaming arguments)."""
        assert self._run_state is not None
        if (
            not self._id
            or not self._conn
            or not part.arguments_part
            or self._run_state.last_tool_call is None
        ):
            return

        # Append new arguments part to the last tool call
        self._run_state.last_tool_call.append_args_part(part.arguments_part)

        # Update the tool call with new content and title
        update = acp.schema.ToolCallProgress(
            session_update="tool_call_update",
            tool_call_id=self._run_state.last_tool_call.acp_tool_call_id,
            title=self._run_state.last_tool_call.get_title(),
            status="in_progress",
            content=[
                acp.schema.ContentToolCallContent(
                    type="content",
                    content=acp.schema.TextContentBlock(
                        type="text", text=self._run_state.last_tool_call.args
                    ),
                )
            ],
        )

        await self._conn.session_update(session_id=self._id, update=update)
        logger.debug("Sent tool call update: {delta}", delta=part.arguments_part[:50])

    async def _send_tool_result(self, result: ToolResult):
        """Send tool result to client."""
        assert self._run_state is not None
        if not self._id or not self._conn:
            return

        tool_ret = result.return_value
        is_error = isinstance(tool_ret, ToolError)

        state = self._run_state.tool_calls.pop(result.tool_call_id, None)
        if state is None:
            logger.warning("Tool call not found: {id}", id=result.tool_call_id)
            return

        update = acp.schema.ToolCallProgress(
            session_update="tool_call_update",
            tool_call_id=state.acp_tool_call_id,
            status="failed" if is_error else "completed",
        )

        contents = tool_result_to_acp_content(tool_ret)
        if contents:
            update.content = contents

        await self._conn.session_update(session_id=self._id, update=update)
        logger.debug("Sent tool result: {id}", id=result.tool_call_id)

    async def _handle_approval_request(self, request: ApprovalRequest):
        """Handle approval request by sending permission request to client."""
        assert self._run_state is not None
        if not self._id or not self._conn:
            logger.warning("No session ID, auto-rejecting approval request")
            request.resolve("reject")
            return

        state = self._run_state.tool_calls.get(request.tool_call_id, None)
        if state is None:
            logger.warning("Tool call not found: {id}", id=request.tool_call_id)
            request.resolve("reject")
            return

        try:
            # Send permission request and wait for response
            logger.debug("Requesting permission for action: {action}", action=request.action)
            response = await self._conn.request_permission(
                [
                    acp.schema.PermissionOption(
                        option_id="approve",
                        name="Approve once",
                        kind="allow_once",
                    ),
                    acp.schema.PermissionOption(
                        option_id="approve_for_session",
                        name="Approve for this session",
                        kind="allow_always",
                    ),
                    acp.schema.PermissionOption(
                        option_id="reject",
                        name="Reject",
                        kind="reject_once",
                    ),
                ],
                self._id,
                acp.schema.ToolCallUpdate(
                    tool_call_id=state.acp_tool_call_id,
                    title=state.get_title(),
                    content=[
                        acp.schema.ContentToolCallContent(
                            type="content",
                            content=acp.schema.TextContentBlock(
                                type="text",
                                text=f"Requesting approval to perform: {request.description}",
                            ),
                        ),
                    ],
                ),
            )
            logger.debug("Received permission response: {response}", response=response)

            # Process the outcome
            if isinstance(response.outcome, acp.schema.AllowedOutcome):
                # selected
                option_id = response.outcome.option_id
                if option_id == "approve":
                    logger.debug("Permission granted for: {action}", action=request.action)
                    request.resolve("approve")
                elif option_id == "approve_for_session":
                    logger.debug("Permission granted for session: {action}", action=request.action)
                    request.resolve("approve_for_session")
                else:
                    logger.debug("Permission denied for: {action}", action=request.action)
                    request.resolve("reject")
            else:
                # cancelled
                logger.debug("Permission request cancelled for: {action}", action=request.action)
                request.resolve("reject")
        except Exception:
            logger.exception("Error handling approval request:")
            # On error, reject the request
            request.resolve("reject")
