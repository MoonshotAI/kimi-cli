from __future__ import annotations

import asyncio
import uuid
from typing import Any

import acp
import streamingjson  # pyright: ignore[reportMissingTypeStubs]
from kosong.chat_provider import ChatProviderError
from kosong.message import (
    ContentPart,
    TextPart,
    ThinkPart,
    ToolCall,
    ToolCallPart,
)
from kosong.tooling import ToolError, ToolResult, ToolReturnValue

from kimi_cli.soul import LLMNotSet, MaxStepsReached, RunCancelled, Soul, run_soul
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.tools import extract_key_argument
from kimi_cli.utils.logging import logger
from kimi_cli.wire import Wire
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
)

McpServer = acp.schema.HttpMcpServer | acp.schema.SseMcpServer | acp.schema.McpServerStdio

PromptContent = (
    acp.schema.TextContentBlock
    | acp.schema.ImageContentBlock
    | acp.schema.AudioContentBlock
    | acp.schema.ResourceContentBlock
    | acp.schema.EmbeddedResourceContentBlock
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


class ACPAgent:
    """Implementation of the ACP Agent protocol."""

    def __init__(self, soul: Soul):
        self.soul = soul
        self.conn: acp.Client | None = None
        self.session_id: str | None = None
        self.run_state: _RunState | None = None

    def on_connect(self, conn: acp.Client) -> None:
        """Handle new client connection."""
        logger.info("ACP client connected")
        self.conn = conn

    async def initialize(
        self,
        protocol_version: int,
        client_capabilities: acp.schema.ClientCapabilities | None = None,
        client_info: acp.schema.Implementation | None = None,
        **kwargs: Any,
    ) -> acp.InitializeResponse:
        """Handle initialize request."""
        logger.info(
            "ACP server initialized with protocol version: {version}",
            version=protocol_version,
        )

        return acp.InitializeResponse(
            protocol_version=protocol_version,
            agent_capabilities=acp.schema.AgentCapabilities(
                load_session=False,
                prompt_capabilities=acp.schema.PromptCapabilities(
                    embedded_context=False, image=False, audio=False
                ),
            ),
            auth_methods=[],
        )

    async def new_session(
        self, cwd: str, mcp_servers: list[McpServer], **kwargs: Any
    ) -> acp.NewSessionResponse:
        """Handle new session request."""
        self.session_id = f"sess_{uuid.uuid4().hex[:16]}"
        logger.info("Created session {id} with cwd: {cwd}", id=self.session_id, cwd=cwd)
        return acp.NewSessionResponse(session_id=self.session_id)

    async def load_session(
        self, cwd: str, mcp_servers: list[McpServer], session_id: str, **kwargs: Any
    ) -> None:
        """Handle load session request."""
        self.session_id = session_id
        logger.info("Loaded session: {id} with cwd: {cwd}", id=self.session_id, cwd=cwd)

    async def list_sessions(
        self, cursor: str | None = None, cwd: str | None = None, **kwargs: Any
    ) -> acp.schema.ListSessionsResponse:
        """Handle list sessions request."""
        logger.info("Listing sessions (not implemented)")
        return acp.schema.ListSessionsResponse(sessions=[], next_cursor=None)

    async def set_session_mode(
        self, mode_id: str, session_id: str, **kwargs: Any
    ) -> acp.SetSessionModeResponse | None:
        """Handle set session mode request."""
        logger.warning("Set session mode: {mode} for session: {id}", mode=mode_id, id=session_id)
        return None

    async def set_session_model(
        self, model_id: str, session_id: str, **kwargs: Any
    ) -> acp.SetSessionModelResponse | None:
        """Handle set session model request."""
        logger.warning(
            "Set session model: {model} for session: {id}", model=model_id, id=session_id
        )

    async def authenticate(self, method_id: str, **kwargs: Any) -> acp.AuthenticateResponse | None:
        """Handle authenticate request."""
        logger.info("Authenticate with method: {method}", method=method_id)
        return None

    async def prompt(
        self, prompt: list[PromptContent], session_id: str, **kwargs: Any
    ) -> acp.PromptResponse:
        """Handle prompt request with streaming support."""
        # Extract text from prompt content blocks
        prompt_text = "\n".join(
            block.text for block in prompt if isinstance(block, acp.schema.TextContentBlock)
        )

        if not prompt_text:
            raise acp.RequestError.invalid_params({"reason": "No text in prompt"})

        logger.info("Processing prompt: {text}", text=prompt_text[:100])

        self.session_id = session_id
        self.run_state = _RunState()
        try:
            await run_soul(
                self.soul,
                prompt_text,
                self._stream_events,
                self.run_state.cancel_event,
                self.soul.wire_file_backend if isinstance(self.soul, KimiSoul) else None,
            )
            return acp.PromptResponse(stop_reason="end_turn")
        except LLMNotSet:
            logger.error("LLM not set")
            raise acp.RequestError.internal_error({"error": "LLM not set"}) from None
        except ChatProviderError as e:
            logger.exception("LLM provider error:")
            raise acp.RequestError.internal_error({"error": f"LLM provider error: {e}"}) from e
        except MaxStepsReached as e:
            logger.warning("Max steps reached: {n}", n=e.n_steps)
            return acp.PromptResponse(stop_reason="max_turn_requests")
        except RunCancelled:
            logger.info("Prompt cancelled by user")
            return acp.PromptResponse(stop_reason="cancelled")
        except BaseException as e:
            logger.exception("Unknown error:")
            raise acp.RequestError.internal_error({"error": f"Unknown error: {e}"}) from e
        finally:
            self.run_state = None

    async def cancel(self, session_id: str, **kwargs: Any) -> None:
        """Handle cancel notification."""
        logger.info("Cancel for session: {id}", id=session_id)

        if self.run_state is None:
            logger.warning("No running prompt to cancel")
            return

        if not self.run_state.cancel_event.is_set():
            logger.info("Cancelling running prompt")
            self.run_state.cancel_event.set()

    async def ext_method(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        """Handle extension method."""
        logger.warning("Unsupported extension method: {method}", method=method)
        return {}

    async def ext_notification(self, method: str, params: dict[str, Any]) -> None:
        """Handle extension notification."""
        logger.warning("Unsupported extension notification: {method}", method=method)

    async def _stream_events(self, wire: Wire):
        wire_ui = wire.ui_side(merge=False)
        while True:
            msg = await wire_ui.receive()
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

    async def _send_thinking(self, think: str):
        """Send thinking content to client."""
        if not self.session_id or not self.conn:
            return

        await self.conn.session_update(
            self.session_id,
            acp.schema.AgentThoughtChunk(
                content=acp.schema.TextContentBlock(type="text", text=think),
                session_update="agent_thought_chunk",
            ),
        )

    async def _send_text(self, text: str):
        """Send text chunk to client."""
        if not self.session_id or not self.conn:
            return

        await self.conn.session_update(
            session_id=self.session_id,
            update=acp.schema.AgentMessageChunk(
                content=acp.schema.TextContentBlock(type="text", text=text),
                session_update="agent_message_chunk",
            ),
        )

    async def _send_tool_call(self, tool_call: ToolCall):
        """Send tool call to client."""
        assert self.run_state is not None
        if not self.session_id or not self.conn:
            return

        # Create and store tool call state
        state = _ToolCallState(tool_call)
        self.run_state.tool_calls[tool_call.id] = state
        self.run_state.last_tool_call = state

        await self.conn.session_update(
            session_id=self.session_id,
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
        assert self.run_state is not None
        if (
            not self.session_id
            or not self.conn
            or not part.arguments_part
            or self.run_state.last_tool_call is None
        ):
            return

        # Append new arguments part to the last tool call
        self.run_state.last_tool_call.append_args_part(part.arguments_part)

        # Update the tool call with new content and title
        update = acp.schema.ToolCallProgress(
            session_update="tool_call_update",
            tool_call_id=self.run_state.last_tool_call.acp_tool_call_id,
            title=self.run_state.last_tool_call.get_title(),
            status="in_progress",
            content=[
                acp.schema.ContentToolCallContent(
                    type="content",
                    content=acp.schema.TextContentBlock(
                        type="text", text=self.run_state.last_tool_call.args
                    ),
                )
            ],
        )

        await self.conn.session_update(session_id=self.session_id, update=update)
        logger.debug("Sent tool call update: {delta}", delta=part.arguments_part[:50])

    async def _send_tool_result(self, result: ToolResult):
        """Send tool result to client."""
        assert self.run_state is not None
        if not self.session_id or not self.conn:
            return

        tool_ret = result.return_value
        is_error = isinstance(tool_ret, ToolError)

        state = self.run_state.tool_calls.pop(result.tool_call_id, None)
        if state is None:
            logger.warning("Tool call not found: {id}", id=result.tool_call_id)
            return

        update = acp.schema.ToolCallProgress(
            session_update="tool_call_update",
            tool_call_id=state.acp_tool_call_id,
            status="failed" if is_error else "completed",
        )

        contents = _tool_result_to_acp_content(tool_ret)
        if contents:
            update.content = contents

        await self.conn.session_update(session_id=self.session_id, update=update)
        logger.debug("Sent tool result: {id}", id=result.tool_call_id)

    async def _handle_approval_request(self, request: ApprovalRequest):
        """Handle approval request by sending permission request to client."""
        assert self.run_state is not None
        if not self.session_id or not self.conn:
            logger.warning("No session ID, auto-rejecting approval request")
            request.resolve("reject")
            return

        state = self.run_state.tool_calls.get(request.tool_call_id, None)
        if state is None:
            logger.warning("Tool call not found: {id}", id=request.tool_call_id)
            request.resolve("reject")
            return

        try:
            # Send permission request and wait for response
            logger.debug("Requesting permission for action: {action}", action=request.action)
            response = await self.conn.request_permission(
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
                self.session_id,
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


def _tool_result_to_acp_content(
    tool_ret: ToolReturnValue,
) -> list[
    acp.schema.ContentToolCallContent
    | acp.schema.FileEditToolCallContent
    | acp.schema.TerminalToolCallContent
]:
    def _to_acp_content(
        part: ContentPart,
    ) -> (
        acp.schema.ContentToolCallContent
        | acp.schema.FileEditToolCallContent
        | acp.schema.TerminalToolCallContent
    ):
        if isinstance(part, TextPart):
            return acp.schema.ContentToolCallContent(
                type="content", content=acp.schema.TextContentBlock(type="text", text=part.text)
            )
        logger.warning("Unsupported content part in tool result: {part}", part=part)
        return acp.schema.ContentToolCallContent(
            type="content",
            content=acp.schema.TextContentBlock(type="text", text=f"[{part.__class__.__name__}]"),
        )

    def _to_text_block(text: str) -> acp.schema.ContentToolCallContent:
        return acp.schema.ContentToolCallContent(
            type="content", content=acp.schema.TextContentBlock(type="text", text=text)
        )

    contents: list[
        acp.schema.ContentToolCallContent
        | acp.schema.FileEditToolCallContent
        | acp.schema.TerminalToolCallContent
    ] = []

    output = tool_ret.output
    if isinstance(output, str):
        if output:
            contents.append(_to_text_block(output))
    else:
        # NOTE: At the moment, ToolReturnValue.output is either a string or a
        # list of ContentPart. We avoid an unnecessary isinstance() check here
        # to keep pyright happy while still handling list outputs.
        contents.extend(_to_acp_content(part) for part in output)

    if not contents and tool_ret.message:
        contents.append(_to_text_block(tool_ret.message))

    return contents


class ACP:
    """ACP server using the official acp library."""

    def __init__(self, soul: Soul):
        self.soul = soul

    async def run(self):
        """Run the ACP server."""
        logger.info("Starting ACP server on stdio")
        await acp.run_agent(ACPAgent(self.soul))
