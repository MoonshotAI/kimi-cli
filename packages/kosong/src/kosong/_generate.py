from collections.abc import Sequence
from dataclasses import dataclass

from loguru import logger

from kosong.chat_provider import (
    APIEmptyResponseError,
    ChatProvider,
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

    logger.trace("Generating with history: {history}", history=history)
    stream = await chat_provider.generate(system_prompt, tools, history)
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

    # end of message
    if pending_part is not None:
        _message_append(message, pending_part)
        if isinstance(pending_part, ToolCall) and on_tool_call:
            await callback(on_tool_call, pending_part)

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
