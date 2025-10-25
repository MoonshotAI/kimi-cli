import asyncio
import uuid

import acp
import streamingjson
from kosong.base.message import (
    ContentPart,
    TextPart,
    ToolCall,
    ToolCallPart,
)
from kosong.chat_provider import ChatProviderError
from kosong.tooling import ToolError, ToolOk, ToolResult

from kimi_cli.soul import LLMNotSet, MaxStepsReached, Soul
from kimi_cli.tools import extract_subtitle
from kimi_cli.utils.logging import logger
from kimi_cli.wire import RunCancelled, WireUISide, run_soul
from kimi_cli.wire.message import (
    ApprovalRequest,
    ApprovalResponse,
    StatusUpdate,
    StepBegin,
    StepInterrupted,
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
        subtitle = extract_subtitle(self.lexer, tool_name)
        if subtitle:
            return f"{tool_name}: {subtitle}"
        return tool_name


class _RunState:
    def __init__(self):
        self.tool_calls: dict[str, _ToolCallState] = {}
        """Map of tool call ID (LLM-side ID) to tool call state."""
        self.last_tool_call: _ToolCallState | None = None
        self.cancel_event = asyncio.Event()


class ACPAgentImpl:
    """Implementation of the ACP Agent protocol."""

    def __init__(self, soul: Soul, connection: acp.AgentSideConnection):
        self.soul = soul
        self.connection = connection
        self.session_id: str | None = None
        self.run_state: _RunState | None = None

    async def initialize(self, params: acp.InitializeRequest) -> acp.InitializeResponse:
        """Handle initialize request."""
        logger.info(
            "ACP server initialized with protocol version: {version}",
            version=params.protocolVersion,
        )

        return acp.InitializeResponse(
            protocolVersion=params.protocolVersion,
            agentCapabilities=acp.schema.AgentCapabilities(
                loadSession=False,
                promptCapabilities=acp.schema.PromptCapabilities(
                    embeddedContext=False, image=False, audio=False
                ),
            ),
            authMethods=[],
        )

    async def authenticate(self, params: acp.AuthenticateRequest) -> None:
        """Handle authenticate request."""
        logger.info("Authenticate with method: {method}", method=params.methodId)

    async def newSession(self, params: acp.NewSessionRequest) -> acp.NewSessionResponse:
        """Handle new session request."""
        self.session_id = f"sess_{uuid.uuid4().hex[:16]}"
        logger.info("Created session {id} with cwd: {cwd}", id=self.session_id, cwd=params.cwd)
        return acp.NewSessionResponse(sessionId=self.session_id)

    async def loadSession(self, params: acp.LoadSessionRequest) -> None:
        """Handle load session request."""
        self.session_id = params.sessionId
        logger.info("Loaded session: {id}", id=self.session_id)

    async def setSessionModel(self, params: acp.SetSessionModelRequest) -> None:
        """Handle set session model request."""
        logger.warning("Set session model: {model}", model=params.modelId)

    async def setSessionMode(
        self, params: acp.SetSessionModeRequest
    ) -> acp.SetSessionModeResponse | None:
        """Handle set session mode request."""
        logger.warning("Set session mode: {mode}", mode=params.modeId)
        return None

    async def extMethod(self, method: str, params: dict) -> dict:
        """Handle extension method."""
        logger.warning("Unsupported extension method: {method}", method=method)
        return {}

    async def extNotification(self, method: str, params: dict) -> None:
        """Handle extension notification."""
        logger.warning("Unsupported extension notification: {method}", method=method)

    async def prompt(self, params: acp.PromptRequest) -> acp.PromptResponse:
        """Handle prompt request with streaming support."""
        # Extract text from prompt content blocks
        prompt_text = "\n".join(
            block.text for block in params.prompt if isinstance(block, acp.schema.TextContentBlock)
        )

        if not prompt_text:
            raise acp.RequestError.invalid_params({"reason": "No text in prompt"})

        logger.info("Processing prompt: {text}", text=prompt_text[:100])

        self.run_state = _RunState()
        try:
            await run_soul(self.soul, prompt_text, self._stream_events, self.run_state.cancel_event)
            return acp.PromptResponse(stopReason="end_turn")
        except LLMNotSet:
            logger.error("LLM not set")
            raise acp.RequestError.internal_error({"error": "LLM not set"}) from None
        except ChatProviderError as e:
            logger.exception("LLM provider error:")
            raise acp.RequestError.internal_error({"error": f"LLM provider error: {e}"}) from e
        except MaxStepsReached as e:
            logger.warning("Max steps reached: {n}", n=e.n_steps)
            return acp.PromptResponse(stopReason="max_turn_requests")
        except RunCancelled:
            logger.info("Prompt cancelled by user")
            return acp.PromptResponse(stopReason="cancelled")
        except BaseException as e:
            logger.exception("Unknown error:")
            raise acp.RequestError.internal_error({"error": f"Unknown error: {e}"}) from e
        finally:
            self.run_state = None

    async def cancel(self, params: acp.CancelNotification) -> None:
        """Handle cancel notification."""
        logger.info("Cancel for session: {id}", id=params.sessionId)

        if self.run_state is None:
            logger.warning("No running prompt to cancel")
            return

        if not self.run_state.cancel_event.is_set():
            logger.info("Cancelling running prompt")
            self.run_state.cancel_event.set()

    async def _stream_events(self, wire: WireUISide):
        try:
            # expect a StepBegin
            assert isinstance(await wire.receive(), StepBegin)

            while True:
                msg = await wire.receive()

                if isinstance(msg, TextPart):
                    await self._send_text(msg.text)
                elif isinstance(msg, ContentPart):
                    logger.warning("Unsupported content part: {part}", part=msg)
                    await self._send_text(f"[{msg.__class__.__name__}]")
                elif isinstance(msg, ToolCall):
                    await self._send_tool_call(msg)
                elif isinstance(msg, ToolCallPart):
                    await self._send_tool_call_part(msg)
                elif isinstance(msg, ToolResult):
                    await self._send_tool_result(msg)
                elif isinstance(msg, ApprovalRequest):
                    await self._handle_approval_request(msg)
                elif isinstance(msg, StatusUpdate):
                    # TODO: stream status if needed
                    pass
                elif isinstance(msg, StepInterrupted):
                    break
        except asyncio.QueueShutDown:
            logger.debug("Event stream loop shutting down")

    async def _send_text(self, text: str):
        """Send text chunk to client."""
        if not self.session_id:
            return

        await self.connection.sessionUpdate(
            acp.SessionNotification(
                sessionId=self.session_id,
                update=acp.schema.AgentMessageChunk(
                    content=acp.schema.TextContentBlock(type="text", text=text),
                    sessionUpdate="agent_message_chunk",
                ),
            )
        )

    async def _send_tool_call(self, tool_call: ToolCall):
        """Send tool call to client."""
        assert self.run_state is not None
        if not self.session_id:
            return

        # Create and store tool call state
        state = _ToolCallState(tool_call)
        self.run_state.tool_calls[tool_call.id] = state
        self.run_state.last_tool_call = state

        await self.connection.sessionUpdate(
            acp.SessionNotification(
                sessionId=self.session_id,
                update=acp.schema.ToolCallStart(
                    sessionUpdate="tool_call",
                    toolCallId=state.acp_tool_call_id,
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
        )
        logger.debug("Sent tool call: {name}", name=tool_call.function.name)

    async def _send_tool_call_part(self, part: ToolCallPart):
        """Send tool call part (streaming arguments)."""
        assert self.run_state is not None
        if not self.session_id or not part.arguments_part or self.run_state.last_tool_call is None:
            return

        # Append new arguments part to the last tool call
        self.run_state.last_tool_call.append_args_part(part.arguments_part)

        # Update the tool call with new content and title
        update = acp.schema.ToolCallProgress(
            sessionUpdate="tool_call_update",
            toolCallId=self.run_state.last_tool_call.acp_tool_call_id,
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

        await self.connection.sessionUpdate(
            acp.SessionNotification(sessionId=self.session_id, update=update)
        )
        logger.debug("Sent tool call update: {delta}", delta=part.arguments_part[:50])

    async def _send_tool_result(self, result: ToolResult):
        """Send tool result to client."""
        assert self.run_state is not None
        if not self.session_id:
            return

        tool_result = result.result
        is_error = isinstance(tool_result, ToolError)

        state = self.run_state.tool_calls.pop(result.tool_call_id, None)
        if state is None:
            logger.warning("Tool call not found: {id}", id=result.tool_call_id)
            return

        update = acp.schema.ToolCallProgress(
            sessionUpdate="tool_call_update",
            toolCallId=state.acp_tool_call_id,
            status="failed" if is_error else "completed",
        )

        if state.tool_call.function.name == "SetTodoList" and not is_error:
            update.content = _tool_result_to_acp_content(tool_result)

        await self.connection.sessionUpdate(
            acp.SessionNotification(sessionId=self.session_id, update=update)
        )

        logger.debug("Sent tool result: {id}", id=result.tool_call_id)

    async def _handle_approval_request(self, request: ApprovalRequest):
        """Handle approval request by sending permission request to client."""
        assert self.run_state is not None
        if not self.session_id:
            logger.warning("No session ID, auto-rejecting approval request")
            request.resolve(ApprovalResponse.REJECT)
            return

        state = self.run_state.tool_calls.get(request.tool_call_id, None)
        if state is None:
            logger.warning("Tool call not found: {id}", id=request.tool_call_id)
            request.resolve(ApprovalResponse.REJECT)
            return

        # Create permission request with options
        permission_request = acp.RequestPermissionRequest(
            sessionId=self.session_id,
            toolCall=acp.schema.ToolCallUpdate(
                toolCallId=state.acp_tool_call_id,
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
            options=[
                acp.schema.PermissionOption(
                    optionId="approve",
                    name="Approve",
                    kind="allow_once",
                ),
                acp.schema.PermissionOption(
                    optionId="approve_for_session",
                    name="Approve for this session",
                    kind="allow_always",
                ),
                acp.schema.PermissionOption(
                    optionId="reject",
                    name="Reject",
                    kind="reject_once",
                ),
            ],
        )

        try:
            # Send permission request and wait for response
            logger.debug("Requesting permission for action: {action}", action=request.action)
            response = await self.connection.requestPermission(permission_request)
            logger.debug("Received permission response: {response}", response=response)

            # Process the outcome
            if isinstance(response.outcome, acp.schema.AllowedOutcome):
                # selected
                if response.outcome.optionId == "approve":
                    logger.debug("Permission granted for: {action}", action=request.action)
                    request.resolve(ApprovalResponse.APPROVE)
                elif response.outcome.optionId == "approve_for_session":
                    logger.debug("Permission granted for session: {action}", action=request.action)
                    request.resolve(ApprovalResponse.APPROVE_FOR_SESSION)
                else:
                    logger.debug("Permission denied for: {action}", action=request.action)
                    request.resolve(ApprovalResponse.REJECT)
            else:
                # cancelled
                logger.debug("Permission request cancelled for: {action}", action=request.action)
                request.resolve(ApprovalResponse.REJECT)
        except Exception:
            logger.exception("Error handling approval request:")
            # On error, reject the request
            request.resolve(ApprovalResponse.REJECT)


def _tool_result_to_acp_content(
    tool_result: ToolOk | ToolError,
) -> list[
    acp.schema.ContentToolCallContent
    | acp.schema.FileEditToolCallContent
    | acp.schema.TerminalToolCallContent
]:
    def _to_acp_content(part: ContentPart) -> acp.schema.ContentToolCallContent:
        if isinstance(part, TextPart):
            return acp.schema.ContentToolCallContent(
                type="content", content=acp.schema.TextContentBlock(type="text", text=part.text)
            )
        else:
            logger.warning("Unsupported content part in tool result: {part}", part=part)
            return acp.schema.ContentToolCallContent(
                type="content",
                content=acp.schema.TextContentBlock(
                    type="text", text=f"[{part.__class__.__name__}]"
                ),
            )

    content = []
    if isinstance(tool_result.output, str):
        content.append(_to_acp_content(TextPart(text=tool_result.output)))
    elif isinstance(tool_result.output, ContentPart):
        content.append(_to_acp_content(tool_result.output))
    elif isinstance(tool_result.output, list):
        content.extend(_to_acp_content(part) for part in tool_result.output)

    return content


class ACPServer:
    """ACP server using the official acp library."""

    def __init__(self, soul: Soul):
        self.soul = soul

    async def run(self) -> bool:
        """Run the ACP server."""
        logger.info("Starting ACP server on stdio")

        # Get stdio streams
        reader, writer = await acp.stdio_streams()

        # Create connection - the library handles all JSON-RPC details!
        _ = acp.AgentSideConnection(
            lambda conn: ACPAgentImpl(self.soul, conn),
            writer,
            reader,
        )

        logger.info("ACP server ready")

        # Keep running - connection handles everything
        await asyncio.Event().wait()

        return True
