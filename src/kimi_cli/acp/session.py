from __future__ import annotations

import asyncio
import uuid
from contextvars import ContextVar, Token
from datetime import datetime

import acp
import streamingjson  # type: ignore[reportMissingTypeStubs]
from kaos import Kaos, reset_current_kaos, set_current_kaos
from kosong.chat_provider import APIStatusError, ChatProviderError

from kimi_cli.acp.convert import (
    acp_blocks_to_content_parts,
    display_block_to_acp_content,
    tool_result_to_acp_content,
)
from kimi_cli.acp.types import ACPContentBlock
from kimi_cli.app import KimiCLI
from kimi_cli.soul import LLMNotSet, LLMNotSupported, MaxStepsReached, RunCancelled
from kimi_cli.tools import extract_key_argument
from kimi_cli.utils.logging import logger
from kimi_cli.wire.types import (
    ApprovalRequest,
    ApprovalResponse,
    AudioURLPart,
    CompactionBegin,
    CompactionEnd,
    ContentPart,
    ImageURLPart,
    MCPLoadingBegin,
    MCPLoadingEnd,
    Notification,
    PlanDisplay,
    QuestionRequest,
    StatusUpdate,
    SteerInput,
    StepBegin,
    StepInterrupted,
    StepRetry,
    SubagentEvent,
    TextPart,
    ThinkPart,
    TodoDisplayBlock,
    ToolCall,
    ToolCallPart,
    ToolCallRequest,
    ToolResult,
    TurnBegin,
    TurnEnd,
)

_current_turn_id = ContextVar[str | None]("current_turn_id", default=None)
_terminal_tool_call_ids = ContextVar[set[str] | None]("terminal_tool_call_ids", default=None)


def get_current_acp_tool_call_id_or_none() -> str | None:
    """See `_ToolCallState.acp_tool_call_id`."""
    from kimi_cli.soul.toolset import get_current_tool_call_or_none

    turn_id = _current_turn_id.get()
    if turn_id is None:
        return None
    tool_call = get_current_tool_call_or_none()
    if tool_call is None:
        return None
    return f"{turn_id}/{tool_call.id}"


def register_terminal_tool_call_id(tool_call_id: str) -> None:
    calls = _terminal_tool_call_ids.get()
    if calls is not None:
        calls.add(tool_call_id)


def should_hide_terminal_output(tool_call_id: str) -> bool:
    calls = _terminal_tool_call_ids.get()
    return calls is not None and tool_call_id in calls


def _content_part_to_acp_block(part: ContentPart) -> ACPContentBlock:
    if isinstance(part, TextPart):
        return acp.schema.TextContentBlock(type="text", text=part.text)
    if isinstance(part, ImageURLPart):
        mime_type, data = _split_data_url(part.image_url.url)
        if data is not None:
            return acp.schema.ImageContentBlock(type="image", mime_type=mime_type, data=data)
        return acp.schema.ResourceContentBlock(
            type="resource_link",
            uri=part.image_url.url,
            name="image",
            mime_type=mime_type,
        )
    if isinstance(part, AudioURLPart):
        mime_type, data = _split_data_url(part.audio_url.url)
        if data is not None:
            return acp.schema.AudioContentBlock(type="audio", mime_type=mime_type, data=data)
        return acp.schema.ResourceContentBlock(
            type="resource_link",
            uri=part.audio_url.url,
            name="audio",
            mime_type=mime_type,
        )

    logger.warning("Unsupported replay user content part: {part}", part=part)
    return acp.schema.TextContentBlock(type="text", text=f"[{part.__class__.__name__}]")


def _split_data_url(url: str) -> tuple[str, str | None]:
    if not url.startswith("data:"):
        return "application/octet-stream", None
    header, sep, data = url.partition(",")
    if not sep or ";base64" not in header:
        return "application/octet-stream", None
    mime_type = header.removeprefix("data:").removesuffix(";base64")
    return mime_type or "application/octet-stream", data


class _ToolCallState:
    """Manages the state of a single tool call for streaming updates."""

    def __init__(self, tool_call: ToolCall):
        self.tool_call = tool_call
        self.args = tool_call.function.arguments or ""
        self.lexer = streamingjson.Lexer()
        if tool_call.function.arguments is not None:
            self.lexer.append_string(tool_call.function.arguments)

    @property
    def acp_tool_call_id(self) -> str:
        # When the user rejected or cancelled a tool call, the step result may not
        # be appended to the context. In this case, future step may emit tool call
        # with the same tool call ID (on the LLM side). To avoid confusion of the
        # ACP client, we ensure the uniqueness by prefixing with the turn ID.
        turn_id = _current_turn_id.get()
        assert turn_id is not None
        return f"{turn_id}/{self.tool_call.id}"

    def append_args_part(self, args_part: str) -> None:
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


class _TurnState:
    def __init__(self):
        self.id = str(uuid.uuid4())
        """Unique ID for the turn."""
        self.tool_calls: dict[str, _ToolCallState] = {}
        """Map of tool call ID (LLM-side ID) to tool call state."""
        self.last_tool_call: _ToolCallState | None = None
        self.content_run_kind: str | None = None
        """The active ACP content run kind: `message` or `thought`."""
        self.content_run_message_id: str | None = None
        """Stable ACP message ID for the current contiguous content run."""
        self.cancel_event = asyncio.Event()

    def reset_content_run(self) -> None:
        self.content_run_kind = None
        self.content_run_message_id = None

    def content_run_id(self, kind: str) -> str:
        if self.content_run_kind != kind or self.content_run_message_id is None:
            self.content_run_kind = kind
            self.content_run_message_id = str(uuid.uuid4())
        return self.content_run_message_id


class ACPSession:
    def __init__(
        self,
        id: str,
        cli: KimiCLI,
        acp_conn: acp.Client,
        kaos: Kaos | None = None,
    ) -> None:
        self._id = id
        self._cli = cli
        self._conn = acp_conn
        self._kaos = kaos
        self._turn_state: _TurnState | None = None

    @property
    def id(self) -> str:
        """The ID of the ACP session."""
        return self._id

    @property
    def cli(self) -> KimiCLI:
        """The Kimi Code CLI instance bound to this ACP session."""
        return self._cli

    def _is_oauth_session(self) -> bool:
        """Return True if the current session uses OAuth-based authentication."""
        try:
            llm = self._cli.soul.runtime.llm
            return llm is not None and getattr(llm.provider_config, "oauth", None) is not None
        except AttributeError:
            return False

    async def prompt(self, prompt: list[ACPContentBlock]) -> acp.PromptResponse:
        user_input = acp_blocks_to_content_parts(prompt)
        self._turn_state = _TurnState()
        token = _current_turn_id.set(self._turn_state.id)
        kaos_token = set_current_kaos(self._kaos) if self._kaos is not None else None
        terminal_tool_calls_token = _terminal_tool_call_ids.set(set())
        try:
            async for msg in self._cli.run(user_input, self._turn_state.cancel_event):
                match msg:
                    case TurnBegin():
                        self._reset_content_run()
                    case SteerInput():
                        self._reset_content_run()
                    case TurnEnd():
                        self._reset_content_run()
                    case StepBegin():
                        self._reset_content_run()
                    case StepInterrupted():
                        self._reset_content_run()
                        break
                    case StepRetry():
                        self._reset_content_run()
                    case CompactionBegin():
                        self._reset_content_run()
                    case CompactionEnd():
                        self._reset_content_run()
                    case MCPLoadingBegin():
                        self._reset_content_run()
                    case MCPLoadingEnd():
                        self._reset_content_run()
                    case StatusUpdate():
                        self._reset_content_run()
                    case Notification():
                        self._reset_content_run()
                        await self._send_notification(msg)
                        self._reset_content_run()
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
                    case ApprovalResponse():
                        pass
                    case SubagentEvent():
                        pass
                    case PlanDisplay():
                        pass
                    case ApprovalRequest():
                        await self._handle_approval_request(msg)
                    case ToolCallRequest():
                        logger.warning("Unexpected ToolCallRequest in ACP session: {msg}", msg=msg)
                    case QuestionRequest():
                        logger.warning(
                            "QuestionRequest is unsupported in ACP session; resolving empty answer."
                        )
                        msg.resolve({})
                    case _:
                        pass
        except LLMNotSet as e:
            logger.exception("LLM not set:")
            raise acp.RequestError.auth_required() from e
        except LLMNotSupported as e:
            logger.exception("LLM not supported:")
            raise acp.RequestError.internal_error({"error": str(e)}) from e
        except APIStatusError as e:
            if e.status_code == 401 and self._is_oauth_session():
                logger.warning("Authentication failed (401), prompting re-login")
                raise acp.RequestError.auth_required() from e
            logger.exception("LLM API status error:")
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
            self._turn_state = None
            if kaos_token is not None:
                reset_current_kaos(kaos_token)
            _terminal_tool_call_ids.reset(terminal_tool_calls_token)
            _current_turn_id.reset(token)
        await self.send_session_info_update()
        return acp.PromptResponse(stop_reason="end_turn")

    async def replay_history(self) -> int:
        """Replay persisted wire history as ACP session updates."""
        old_turn_state = self._turn_state
        turn_token: Token[str | None] | None = None
        replayed_updates = 0
        self._turn_state = None
        try:
            async for record in self._cli.soul.runtime.session.wire_file.iter_records():
                msg = record.to_wire_message()
                match msg:
                    case TurnBegin(user_input=user_input):
                        if turn_token is not None:
                            _current_turn_id.reset(turn_token)
                        self._turn_state = _TurnState()
                        turn_token = _current_turn_id.set(self._turn_state.id)
                        replayed_updates += await self._send_user_input(user_input)
                    case SteerInput(user_input=user_input):
                        if turn_token is None:
                            turn_token = self._begin_replay_turn()
                        self._reset_content_run()
                        replayed_updates += await self._send_user_input(user_input)
                    case TurnEnd() | StepInterrupted():
                        if turn_token is not None:
                            _current_turn_id.reset(turn_token)
                            turn_token = None
                        self._turn_state = None
                    case StepBegin():
                        if turn_token is None:
                            turn_token = self._begin_replay_turn()
                    case ThinkPart(think=think):
                        if turn_token is None:
                            turn_token = self._begin_replay_turn()
                        await self._send_thinking(think)
                        replayed_updates += 1
                    case TextPart(text=text):
                        if turn_token is None:
                            turn_token = self._begin_replay_turn()
                        await self._send_text(text)
                        replayed_updates += 1
                    case ContentPart():
                        if turn_token is None:
                            turn_token = self._begin_replay_turn()
                        logger.warning("Unsupported replay content part: {part}", part=msg)
                        await self._send_text(f"[{msg.__class__.__name__}]")
                        replayed_updates += 1
                    case ToolCall():
                        if turn_token is None:
                            turn_token = self._begin_replay_turn()
                        await self._send_tool_call(msg)
                        replayed_updates += 1
                    case ToolCallPart():
                        if self._turn_state is not None:
                            await self._send_tool_call_part(msg)
                            replayed_updates += 1
                    case ToolResult():
                        if self._turn_state is not None:
                            await self._send_tool_result(msg)
                            replayed_updates += 1
                    case Notification():
                        if turn_token is None:
                            turn_token = self._begin_replay_turn()
                        self._reset_content_run()
                        await self._send_notification(msg)
                        self._reset_content_run()
                        replayed_updates += 1
                    case _:
                        pass
        finally:
            if turn_token is not None:
                _current_turn_id.reset(turn_token)
            self._turn_state = old_turn_state
        if replayed_updates == 0:
            replayed_updates = await self._replay_context_history()
        return replayed_updates

    def _begin_replay_turn(self) -> Token[str | None]:
        self._turn_state = _TurnState()
        return _current_turn_id.set(self._turn_state.id)

    async def _replay_context_history(self) -> int:
        old_turn_state = self._turn_state
        turn_token: Token[str | None] | None = None
        replayed_updates = 0
        self._turn_state = None
        try:
            for message in self._cli.soul.context.history:
                if turn_token is not None:
                    _current_turn_id.reset(turn_token)
                turn_token = self._begin_replay_turn()

                if message.role == "user":
                    replayed_updates += await self._send_user_input(list(message.content))
                elif message.role == "assistant":
                    for part in message.content:
                        if isinstance(part, ThinkPart):
                            await self._send_thinking(part.think)
                        elif isinstance(part, TextPart):
                            await self._send_text(part.text)
                        else:
                            logger.warning("Unsupported context replay part: {part}", part=part)
                            await self._send_text(f"[{part.__class__.__name__}]")
                        replayed_updates += 1
        finally:
            if turn_token is not None:
                _current_turn_id.reset(turn_token)
            self._turn_state = old_turn_state
        return replayed_updates

    async def _send_user_input(self, user_input: str | list[ContentPart]) -> int:
        blocks: list[ACPContentBlock]
        if isinstance(user_input, str):
            blocks = [acp.schema.TextContentBlock(type="text", text=user_input)]
        else:
            blocks = [_content_part_to_acp_block(part) for part in user_input]

        for block in blocks:
            await self._send_user_block(block)
        return len(blocks)

    async def _send_user_block(self, block: ACPContentBlock) -> None:
        if not self._id or not self._conn:
            return

        await self._conn.session_update(
            session_id=self._id,
            update=acp.schema.UserMessageChunk(
                content=block,
                message_id=self._content_run_id("user"),
                session_update="user_message_chunk",
            ),
        )

    async def cancel(self) -> None:
        if self._turn_state is None:
            logger.warning("Cancel requested but no prompt is running")
            return

        self._turn_state.cancel_event.set()

    async def send_session_info_update(self) -> None:
        """Send current session metadata, including title, if available."""
        if not self._id or not self._conn:
            return

        try:
            session = self._cli.soul.runtime.session
        except AttributeError:
            return
        title = session.state.custom_title or session.title
        updated_at = (
            datetime.fromtimestamp(session.context_file.stat().st_mtime).astimezone().isoformat()
            if session.context_file.exists()
            else None
        )
        if title == "Untitled" and updated_at is None:
            return

        await self._conn.session_update(
            session_id=self._id,
            update=acp.schema.SessionInfoUpdate(
                session_update="session_info_update",
                title=title if title != "Untitled" else None,
                updated_at=updated_at,
            ),
        )

    def _reset_content_run(self) -> None:
        if self._turn_state is not None:
            self._turn_state.reset_content_run()

    def _content_run_id(self, kind: str) -> str:
        assert self._turn_state is not None
        return self._turn_state.content_run_id(kind)

    async def _send_thinking(self, think: str):
        """Send thinking content to client."""
        if not self._id or not self._conn:
            return

        await self._conn.session_update(
            self._id,
            acp.schema.AgentThoughtChunk(
                content=acp.schema.TextContentBlock(type="text", text=think),
                message_id=self._content_run_id("thought"),
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
                message_id=self._content_run_id("message"),
                session_update="agent_message_chunk",
            ),
        )

    async def _send_notification(self, notification: Notification):
        """Send a system notification to the client as a text chunk."""
        body = notification.body.strip()
        text = f"[Notification] {notification.title}"
        if body:
            text = f"{text}\n{body}"
        await self._send_text(text)

    async def _send_tool_call(self, tool_call: ToolCall):
        """Send tool call to client."""
        assert self._turn_state is not None
        if not self._id or not self._conn:
            return
        self._reset_content_run()

        # Create and store tool call state
        state = _ToolCallState(tool_call)
        self._turn_state.tool_calls[tool_call.id] = state
        self._turn_state.last_tool_call = state

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
        assert self._turn_state is not None
        if (
            not self._id
            or not self._conn
            or not part.arguments_part
            or self._turn_state.last_tool_call is None
        ):
            return

        # Append new arguments part to the last tool call
        self._turn_state.last_tool_call.append_args_part(part.arguments_part)

        # Update the tool call with new content and title
        update = acp.schema.ToolCallProgress(
            session_update="tool_call_update",
            tool_call_id=self._turn_state.last_tool_call.acp_tool_call_id,
            title=self._turn_state.last_tool_call.get_title(),
            status="in_progress",
            content=[
                acp.schema.ContentToolCallContent(
                    type="content",
                    content=acp.schema.TextContentBlock(
                        type="text", text=self._turn_state.last_tool_call.args
                    ),
                )
            ],
        )

        await self._conn.session_update(session_id=self._id, update=update)
        logger.debug("Sent tool call update: {delta}", delta=part.arguments_part[:50])

    async def _send_tool_result(self, result: ToolResult):
        """Send tool result to client."""
        assert self._turn_state is not None
        if not self._id or not self._conn:
            return
        self._reset_content_run()

        tool_ret = result.return_value

        state = self._turn_state.tool_calls.pop(result.tool_call_id, None)
        if state is None:
            logger.warning("Tool call not found: {id}", id=result.tool_call_id)
            return

        update = acp.schema.ToolCallProgress(
            session_update="tool_call_update",
            tool_call_id=state.acp_tool_call_id,
            status="failed" if tool_ret.is_error else "completed",
        )

        contents = (
            []
            if should_hide_terminal_output(state.acp_tool_call_id)
            else tool_result_to_acp_content(tool_ret)
        )
        if contents:
            update.content = contents

        await self._conn.session_update(session_id=self._id, update=update)
        logger.debug("Sent tool result: {id}", id=result.tool_call_id)

        for block in tool_ret.display:
            if isinstance(block, TodoDisplayBlock):
                await self._send_plan_update(block)

    async def _handle_approval_request(self, request: ApprovalRequest):
        """Handle approval request by sending permission request to client."""
        assert self._turn_state is not None
        if not self._id or not self._conn:
            logger.warning("No session ID, auto-rejecting approval request")
            request.resolve("reject")
            return

        state = self._turn_state.tool_calls.get(request.tool_call_id, None)
        if state is None:
            logger.warning("Tool call not found: {id}", id=request.tool_call_id)
            request.resolve("reject")
            return

        try:
            content: list[
                acp.schema.ContentToolCallContent
                | acp.schema.FileEditToolCallContent
                | acp.schema.TerminalToolCallContent
            ] = []
            if request.display:
                for block in request.display:
                    diff_content = display_block_to_acp_content(block)
                    if diff_content is not None:
                        content.append(diff_content)
            if not content:
                content.append(
                    acp.schema.ContentToolCallContent(
                        type="content",
                        content=acp.schema.TextContentBlock(
                            type="text",
                            text=f"Requesting approval to perform: {request.description}",
                        ),
                    )
                )

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
                    content=content,
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

    async def _send_plan_update(self, block: TodoDisplayBlock) -> None:
        """Send todo list updates as ACP agent plan updates."""

        status_map: dict[str, acp.schema.PlanEntryStatus] = {
            "pending": "pending",
            "in progress": "in_progress",
            "in_progress": "in_progress",
            "done": "completed",
            "completed": "completed",
        }
        entries: list[acp.schema.PlanEntry] = [
            acp.schema.PlanEntry(
                content=todo.title,
                priority="medium",
                status=status_map.get(todo.status.lower(), "pending"),
            )
            for todo in block.items
            if todo.title
        ]

        if not entries:
            logger.warning("No valid todo items to send in plan update: {todos}", todos=block.items)
            return

        await self._conn.session_update(
            session_id=self._id,
            update=acp.schema.AgentPlanUpdate(session_update="plan", entries=entries),
        )
