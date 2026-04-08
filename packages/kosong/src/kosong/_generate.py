import json
from collections.abc import Sequence
from dataclasses import dataclass

from loguru import logger

from kosong.chat_provider import (
    APIEmptyResponseError,
    ChatProvider,
    ChatProviderError,
    StreamedMessagePart,
    TokenUsage,
)
from kosong.message import ContentPart, Message, ToolCall
from kosong.tooling import Tool
from kosong.utils.aio import Callback, callback


async def generate(
    chat_provider: ChatProvider,
    system_prompt: str,
    tools: Sequence[Tool],
    history: Sequence[Message],
    *,
    on_message_part: Callback[[StreamedMessagePart], None] | None = None,
    on_tool_call: Callback[[ToolCall], None] | None = None,
) -> "GenerateResult":
    """
    Generate one message based on the given context.
    Parts of the message will be streamed to the specified callbacks if provided.

    Args:
        chat_provider: The chat provider to use for generation.
        system_prompt: The system prompt to use for generation.
        tools: The tools available for the model to call.
        history: The message history to use for generation.
        on_message_part: An optional callback to be called for each raw message part.
        on_tool_call: An optional callback to be called for each complete tool call.

    Returns:
        A tuple of the generated message and the token usage (if available).
        All parts in the message are guaranteed to be complete and merged as much as possible.

    Raises:
        APIConnectionError: If the API connection fails.
        APITimeoutError: If the API request times out.
        APIStatusError: If the API returns a status code of 4xx or 5xx.
        APIEmptyResponseError: If the API returns an empty response.
        ChatProviderError: If any other recognized chat provider error occurs.
    """
    message = Message(role="assistant", content=[])
    pending_part: StreamedMessagePart | None = None  # message part that is currently incomplete
    stream_error: ChatProviderError | None = None

    logger.trace("Generating with history: {history}", history=history)
    stream = await chat_provider.generate(system_prompt, tools, history)
    try:
        async for part in stream:
            logger.trace("Received part: {part}", part=part)
            if on_message_part:
                await callback(on_message_part, part.model_copy(deep=True))

            if pending_part is None:
                pending_part = part
            elif not pending_part.merge_in_place(part):  # try merge into the pending part
                # unmergeable part must push the pending part to the buffer
                _message_append(message, pending_part)
                if isinstance(pending_part, ToolCall) and on_tool_call:
                    await callback(on_tool_call, pending_part)
                pending_part = part
    except ChatProviderError as e:
        # Stream broke mid-flight. If we already received at least one complete ToolCall,
        # treat this as a partial success and continue with what we have — the alternative
        # is losing all work the model already produced.
        stream_error = e

    # Flush the pending part into the message buffer.
    if pending_part is not None:
        _message_append(message, pending_part)
        if isinstance(pending_part, ToolCall) and on_tool_call and stream_error is None:
            await callback(on_tool_call, pending_part)

    if stream_error is not None:
        if _has_complete_tool_calls(message):
            # Recovery succeeded — now safe to dispatch the deferred pending tool call.
            if isinstance(pending_part, ToolCall) and on_tool_call:
                await callback(on_tool_call, pending_part)
            logger.warning(
                "Stream interrupted after receiving {n} tool call(s); "
                "recovering with partial result: {error_type}: {error}",
                n=len(message.tool_calls or []),
                error_type=type(stream_error).__name__,
                error=stream_error,
            )
        else:
            raise stream_error

    if not message.content and not message.tool_calls:
        raise APIEmptyResponseError("The API returned an empty response.")

    return GenerateResult(
        id=stream.id,
        message=message,
        usage=stream.usage,
    )


@dataclass(frozen=True, slots=True)
class GenerateResult:
    """The result of a generation."""

    id: str | None
    """The ID of the generated message."""
    message: Message
    """The generated message."""
    usage: TokenUsage | None
    """The token usage of the generated message."""


def _has_complete_tool_calls(message: Message) -> bool:
    """Check if the message contains at least one ToolCall with well-formed arguments.

    A ToolCall is considered complete when its ``arguments`` is either ``None``
    (some tools accept no arguments) or valid JSON.  If *any* ToolCall has
    malformed (truncated) arguments the entire message is considered incomplete
    — the stream likely broke mid-transfer and recovery would only produce a
    useless parse-error round.
    """
    if not message.tool_calls:
        return False
    for tc in message.tool_calls:
        args = tc.function.arguments
        if args is not None and args != "":
            try:
                json.loads(args)
            except (json.JSONDecodeError, ValueError):
                return False
    return True


def _message_append(message: Message, part: StreamedMessagePart) -> None:
    match part:
        case ContentPart():
            message.content.append(part)
        case ToolCall():
            if message.tool_calls is None:
                message.tool_calls = []
            message.tool_calls.append(part)
        case _:
            # may be an orphaned `ToolCallPart`
            return
