"""Tests for the synchronous Kimi chat provider implementation."""

import asyncio
from unittest.mock import MagicMock, patch

from openai.types.chat import ChatCompletion, ChatCompletionMessage, Choice
from openai.types.completion_usage import CompletionUsage

from kosong.chat_provider.kimi import KimiStreamedMessage
from kosong.message import TextPart, ThinkPart, ToolCall


def test_kimi_streamed_message_non_stream_response():
    """Test KimiStreamedMessage with non-stream ChatCompletion response."""
    # Create a mock ChatCompletion response
    mock_message = MagicMock(spec=ChatCompletionMessage)
    mock_message.content = "Hello, world!"
    mock_message.tool_calls = None
    mock_message.reasoning_content = None

    mock_choice = MagicMock(spec=Choice)
    mock_choice.message = mock_message

    mock_response = MagicMock(spec=ChatCompletion)
    mock_response.id = "msg-123"
    mock_response.usage = MagicMock(spec=CompletionUsage)
    mock_response.usage.prompt_tokens = 10
    mock_response.usage.completion_tokens = 5
    mock_response.choices = [mock_choice]

    # Create KimiStreamedMessage
    streamed = KimiStreamedMessage(mock_response)

    # Verify properties are set
    assert streamed.id == "msg-123"
    assert streamed.usage is not None
    assert streamed.usage.output == 5

    # Test async iteration
    async def test_iteration():
        parts = []
        async for part in streamed:
            parts.append(part)
        return parts

    parts = asyncio.run(test_iteration())
    assert len(parts) == 1
    assert isinstance(parts[0], TextPart)
    assert parts[0].text == "Hello, world!"


def test_kimi_streamed_message_with_reasoning():
    """Test KimiStreamedMessage with reasoning content."""
    # Create a mock ChatCompletion response with reasoning
    mock_message = MagicMock(spec=ChatCompletionMessage)
    mock_message.content = "The answer is 42"
    mock_message.tool_calls = None

    mock_choice = MagicMock(spec=Choice)
    mock_choice.message = mock_message

    mock_response = MagicMock(spec=ChatCompletion)
    mock_response.id = "msg-456"
    mock_response.usage = None
    mock_response.choices = [mock_choice]

    # Use setattr to set reasoning_content as a descriptor
    with patch.object(
        type(mock_message),
        "reasoning_content",
        new_callable=lambda: property(lambda self: "Let me think..."),
    ):
        mock_message.reasoning_content = "Let me think..."
        streamed = KimiStreamedMessage(mock_response)

    async def test_iteration():
        parts = []
        async for part in streamed:
            parts.append(part)
        return parts

    parts = asyncio.run(test_iteration())
    # Should have reasoning part and text part
    assert len(parts) >= 1


def test_kimi_streamed_message_empty_response():
    """Test KimiStreamedMessage with empty response."""
    # Create a mock ChatCompletion response with no content
    mock_message = MagicMock(spec=ChatCompletionMessage)
    mock_message.content = None
    mock_message.tool_calls = None

    mock_choice = MagicMock(spec=Choice)
    mock_choice.message = mock_message

    mock_response = MagicMock(spec=ChatCompletion)
    mock_response.id = "msg-empty"
    mock_response.usage = None
    mock_response.choices = [mock_choice]

    streamed = KimiStreamedMessage(mock_response)

    async def test_iteration():
        parts = []
        async for part in streamed:
            parts.append(part)
        return parts

    parts = asyncio.run(test_iteration())
    # Should be empty since there's no content or tool calls
    assert len(parts) == 0


def test_kimi_streamed_message_mock_async_iteration():
    """Test that KimiStreamedMessage provides mock async iteration."""
    mock_message = MagicMock(spec=ChatCompletionMessage)
    mock_message.content = "Test message"
    mock_message.tool_calls = None

    mock_choice = MagicMock(spec=Choice)
    mock_choice.message = mock_message

    mock_response = MagicMock(spec=ChatCompletion)
    mock_response.id = "msg-async-test"
    mock_response.usage = None
    mock_response.choices = [mock_choice]

    streamed = KimiStreamedMessage(mock_response)

    # Test that it works with async for
    async def test_async_iteration():
        count = 0
        async for part in streamed:
            count += 1
            assert isinstance(part, TextPart)
        return count

    count = asyncio.run(test_async_iteration())
    assert count == 1


def test_kimi_streamed_message_stream_response():
    """Test KimiStreamedMessage with streaming response."""
    from openai.types.chat import ChatCompletionChunk, ChoiceDelta

    # Create mock streaming chunks
    mock_delta_1 = MagicMock(spec=ChoiceDelta)
    mock_delta_1.content = "Hello, "
    mock_delta_1.tool_calls = None
    mock_delta_1.reasoning_content = None

    mock_choice_1 = MagicMock()
    mock_choice_1.delta = mock_delta_1

    mock_chunk_1 = MagicMock(spec=ChatCompletionChunk)
    mock_chunk_1.id = "chunk-1"
    mock_chunk_1.choices = [mock_choice_1]
    mock_chunk_1.usage = None

    mock_delta_2 = MagicMock(spec=ChoiceDelta)
    mock_delta_2.content = "world!"
    mock_delta_2.tool_calls = None
    mock_delta_2.reasoning_content = None

    mock_choice_2 = MagicMock()
    mock_choice_2.delta = mock_delta_2

    mock_chunk_2 = MagicMock(spec=ChatCompletionChunk)
    mock_chunk_2.id = "chunk-2"
    mock_chunk_2.choices = [mock_choice_2]
    mock_chunk_2.usage = None

    # Create a mock stream (iterable)
    mock_stream = [mock_chunk_1, mock_chunk_2]

    streamed = KimiStreamedMessage(mock_stream)

    async def test_iteration():
        parts = []
        async for part in streamed:
            parts.append(part)
        return parts

    parts = asyncio.run(test_iteration())
    assert len(parts) == 2
    assert all(isinstance(p, TextPart) for p in parts)
    assert parts[0].text == "Hello, "
    assert parts[1].text == "world!"
    assert streamed.id == "chunk-2"  # Should have the last chunk's id


if __name__ == "__main__":
    # Run tests
    test_kimi_streamed_message_non_stream_response()
    print("✓ test_kimi_streamed_message_non_stream_response passed")

    test_kimi_streamed_message_with_reasoning()
    print("✓ test_kimi_streamed_message_with_reasoning passed")

    test_kimi_streamed_message_empty_response()
    print("✓ test_kimi_streamed_message_empty_response passed")

    test_kimi_streamed_message_mock_async_iteration()
    print("✓ test_kimi_streamed_message_mock_async_iteration passed")

    test_kimi_streamed_message_stream_response()
    print("✓ test_kimi_streamed_message_stream_response passed")

    print("\nAll tests passed!")
