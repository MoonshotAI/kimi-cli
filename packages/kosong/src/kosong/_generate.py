import asyncio
from collections.abc import Sequence
from dataclasses import dataclass

from loguru import logger

from kosong.chat_provider import (
    APIEmptyResponseError,
    ChatProvider,
    StreamedMessagePart,
    TokenUsage,
)
from kosong.message import ContentPart, Message, TextPart, ThinkPart, ToolCall
from kosong.tooling import Tool
from kosong.utils.aio import Callback, callback


class GenerateCancelled(asyncio.CancelledError):
    """CancelledError carrying the partial message accumulated up to the cancel point.

    Raised by :func:`generate` when its streaming loop is cancelled.  The
    ``message`` field reflects everything observed via the stream so far, with
    any pending part flushed in best-effort fashion — including incomplete
    ToolCall arguments.  No ``on_tool_call`` callback is fired for the flushed
    pending part (we don't want to start a tool the user just cancelled), so
    callers must treat any tool_call in ``message`` without a paired result
    future as "interrupted".
    """

    def __init__(self, message: Message):
        super().__init__()
        self.message = message


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
        GenerateCancelled: When the streaming loop is cancelled.  Carries the
            partial message observed so far so callers can decide whether to
            persist it.
    """
    message = Message(role="assistant", content=[])
    pending_part: StreamedMessagePart | None = None  # message part that is currently incomplete

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
                # Unmergeable part: flush the previously pending one.
                #
                # Invariant: ``pending_part`` is non-None iff that part has
                # NOT yet been appended to ``message``.  Clearing it BEFORE
                # the await means a CancelledError raised inside
                # ``on_tool_call`` can't trick the except-handler below into
                # re-appending the same part — a duplicate tool_call.id
                # would propagate into the partial StepResult and produce
                # duplicate paired tool_results downstream.
                flushing = pending_part
                pending_part = part
                _message_append(message, flushing)
                if isinstance(flushing, ToolCall) and on_tool_call:
                    await callback(on_tool_call, flushing)

        # end of message
        if pending_part is not None:
            # Same race protection as the mid-loop flush: drop the reference
            # before awaiting on_tool_call so a cancel during the callback
            # leaves ``pending_part`` as None in the except handler.
            flushing = pending_part
            pending_part = None
            _message_append(message, flushing)
            if isinstance(flushing, ToolCall) and on_tool_call:
                await callback(on_tool_call, flushing)
    except asyncio.CancelledError:
        # Best-effort flush of the pending part so the caller sees everything
        # the UI has seen.  Crucially do NOT fire on_tool_call here — that
        # callback starts the tool, and the user just asked us to stop.
        # Thanks to the "clear before await" pattern above, pending_part is
        # non-None here only if it was never appended.
        if pending_part is not None:
            _message_append(message, pending_part)
        raise GenerateCancelled(message) from None

    if not message.content and not message.tool_calls:
        raise APIEmptyResponseError("The API returned an empty response.")

    # A response with only ThinkPart (no TextPart, no tool calls) indicates an
    # abnormal termination — typically a stream interruption or max_tokens
    # exhaustion during reasoning.  The model should always produce visible
    # output after thinking; a think-only response is never intentional.
    has_think = any(isinstance(p, ThinkPart) for p in message.content)
    has_text = any(isinstance(p, TextPart) and p.text.strip() for p in message.content)
    if has_think and not has_text and not message.tool_calls:
        raise APIEmptyResponseError(
            "The API returned a response containing only thinking content "
            "without any text or tool calls. This usually indicates the "
            "stream was interrupted or the output token budget was exhausted "
            "during reasoning."
        )

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
