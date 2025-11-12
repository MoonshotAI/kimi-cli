from __future__ import annotations

from kosong.message import ImageURLPart, Message, TextPart
from kosong.tooling import ToolError, ToolOk, ToolResult

from kimi_cli.llm import ModelCapability
from kimi_cli.soul.message import (
    check_message,
    system,
    tool_ok_to_message_content,
    tool_result_to_message,
)


def test_system_message_creation():
    """Test that system messages are properly formatted."""
    message = "Test message"
    result = system(message)

    assert isinstance(result, TextPart)
    assert result.text == f"<system>{message}</system>"


def test_tool_ok_with_string_output():
    """Test ToolOk with string output."""
    tool_ok = ToolOk(output="Hello, world!")
    result = tool_ok_to_message_content(tool_ok)

    assert len(result) == 1  # Only text part (no message field)
    assert isinstance(result[0], TextPart)
    assert result[0].text == "Hello, world!"


def test_tool_ok_with_message():
    """Test ToolOk with explanatory message."""
    tool_ok = ToolOk(output="Result", message="Operation completed")
    result = tool_ok_to_message_content(tool_ok)

    assert len(result) == 2
    assert isinstance(result[0], TextPart)
    assert result[0].text == "<system>Operation completed</system>"
    assert isinstance(result[1], TextPart)
    assert result[1].text == "Result"


def test_tool_ok_with_content_part():
    """Test ToolOk with ContentPart output."""
    content_part = TextPart(text="Text content")
    tool_ok = ToolOk(output=content_part)
    result = tool_ok_to_message_content(tool_ok)

    assert len(result) == 1  # Only content part (no message field)
    assert result[0] == content_part


def test_tool_ok_with_sequence_of_parts():
    """Test ToolOk with sequence of ContentParts."""
    text_part = TextPart(text="Text content")
    text_part_2 = TextPart(text="Text content 2")
    tool_ok = ToolOk(output=[text_part, text_part_2])
    result = tool_ok_to_message_content(tool_ok)

    assert len(result) == 2  # Both parts (no message field)
    assert result[0] == text_part
    assert result[1] == text_part_2


def test_tool_ok_with_empty_output():
    """Test ToolOk with empty output."""
    tool_ok = ToolOk(output="")
    result = tool_ok_to_message_content(tool_ok)

    assert len(result) == 1
    assert isinstance(result[0], TextPart)
    assert result[0].text == "<system>Tool output is empty.</system>"


def test_tool_ok_with_message_but_empty_output():
    """Test ToolOk with message but empty output."""
    tool_ok = ToolOk(output="", message="Just a message")
    result = tool_ok_to_message_content(tool_ok)

    assert len(result) == 1
    assert isinstance(result[0], TextPart)
    assert result[0].text == "<system>Just a message</system>"


def test_tool_error_result():
    """Test ToolResult with ToolError."""
    tool_error = ToolError(message="Error occurred", brief="Brief error", output="Error details")
    tool_result = ToolResult(tool_call_id="call_123", result=tool_error)

    message = tool_result_to_message(tool_result)

    assert isinstance(message, Message)
    assert message.role == "tool"
    assert message.tool_call_id == "call_123"
    assert isinstance(message.content, list)
    assert len(message.content) == 2  # System message + error output
    assert message.content[0] == system("ERROR: Error occurred")
    assert message.content[1] == TextPart(text="Error details")


def test_tool_error_without_output():
    """Test ToolResult with ToolError without output."""
    tool_error = ToolError(message="Error occurred", brief="Brief error")
    tool_result = ToolResult(tool_call_id="call_123", result=tool_error)

    message = tool_result_to_message(tool_result)

    assert isinstance(message, Message)
    assert message.role == "tool"
    assert isinstance(message.content, list)
    assert len(message.content) == 1  # Only system message
    assert message.content[0] == system("ERROR: Error occurred")


def test_tool_ok_with_text_only():
    """Test ToolResult with ToolOk containing only text parts."""
    tool_ok = ToolOk(output="Simple output", message="Done")
    tool_result = ToolResult(tool_call_id="call_123", result=tool_ok)

    message = tool_result_to_message(tool_result)

    assert isinstance(message, Message)
    assert message.role == "tool"
    assert message.tool_call_id == "call_123"
    assert isinstance(message.content, list)
    # Should have system message from ToolOk + text output
    assert len(message.content) == 2
    assert message.content[0] == system("Done")
    assert message.content[1] == TextPart(text="Simple output")


def test_tool_ok_with_non_text_parts():
    """Test ToolResult with ToolOk containing non-text parts."""
    text_part = TextPart(text="Text content")
    image_part = ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/image.jpg"))
    tool_ok = ToolOk(output=[text_part, image_part], message="Mixed content")
    tool_result = ToolResult(tool_call_id="call_123", result=tool_ok)

    # With current implementation, non-text parts are included in the same message
    message = tool_result_to_message(tool_result)

    assert isinstance(message, Message)
    assert message.role == "tool"
    assert message.tool_call_id == "call_123"
    assert isinstance(message.content, list)

    # Should have system message + text part + image part
    assert len(message.content) == 3
    assert message.content[0] == system("Mixed content")
    assert message.content[1] == text_part
    assert message.content[2] == image_part


def test_tool_ok_with_only_non_text_parts():
    """Test ToolResult with ToolOk containing only non-text parts."""
    image_part = ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/image.jpg"))
    tool_ok = ToolOk(output=image_part)
    tool_result = ToolResult(tool_call_id="call_123", result=tool_ok)

    # With current implementation, non-text parts are included in the same message
    message = tool_result_to_message(tool_result)

    assert isinstance(message, Message)
    assert message.role == "tool"
    assert message.tool_call_id == "call_123"
    assert isinstance(message.content, list)
    # Should have only the image part (no text parts)
    assert len(message.content) == 1
    assert message.content[0] == image_part


def test_tool_ok_with_only_text_parts():
    """Test ToolResult with ToolOk containing only text parts."""
    tool_ok = ToolOk(output="Just text")
    tool_result = ToolResult(tool_call_id="call_123", result=tool_ok)

    message = tool_result_to_message(tool_result)

    assert isinstance(message, Message)
    assert message.role == "tool"
    assert isinstance(message.content, list)
    assert len(message.content) == 1
    assert message.content[0] == TextPart(text="Just text")


def test_check_message_with_image_and_image_capability():
    """Test check_message with ImageURLPart when model has image_in capability."""
    image_part = ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/image.jpg"))
    message = Message(role="user", content=[image_part])
    model_capabilities: set[ModelCapability] = {"image_in", "thinking"}

    missing_capabilities = check_message(message, model_capabilities)

    assert missing_capabilities == set()


def test_check_message_with_image_no_image_capability():
    """Test check_message with ImageURLPart when model lacks image_in capability."""
    image_part = ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/image.jpg"))
    message = Message(role="user", content=[image_part])
    model_capabilities: set[ModelCapability] = {"thinking"}

    missing_capabilities = check_message(message, model_capabilities)

    assert missing_capabilities == {"image_in"}


def test_check_message_with_think_and_think_capability():
    """Test check_message with ThinkPart when model has thinking capability."""
    from kosong.message import ThinkPart

    think_part = ThinkPart(think="This is a thinking process")
    message = Message(role="assistant", content=[think_part])
    model_capabilities: set[ModelCapability] = {"image_in", "thinking"}

    missing_capabilities = check_message(message, model_capabilities)

    assert missing_capabilities == set()


def test_check_message_with_think_no_think_capability():
    """Test check_message with ThinkPart when model lacks thinking capability."""
    from kosong.message import ThinkPart

    think_part = ThinkPart(think="This is a thinking process")
    message = Message(role="assistant", content=[think_part])
    model_capabilities: set[ModelCapability] = {"image_in"}

    missing_capabilities = check_message(message, model_capabilities)

    assert missing_capabilities == {"thinking"}


def test_check_message_with_mixed_parts_partial_capabilities():
    """Test check_message with both ImageURLPart and ThinkPart, model has only one capability."""
    from kosong.message import ThinkPart

    image_part = ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/image.jpg"))
    think_part = ThinkPart(think="Thinking...")
    message = Message(role="user", content=[image_part, think_part])
    model_capabilities: set[ModelCapability] = {"image_in"}

    missing_capabilities = check_message(message, model_capabilities)

    assert missing_capabilities == {"thinking"}


def test_check_message_with_text_only():
    """Test check_message with only TextPart (no special capabilities needed)."""
    text_part = TextPart(text="Just a text message")
    message = Message(role="user", content=[text_part])
    model_capabilities: set[ModelCapability] = set()

    missing_capabilities = check_message(message, model_capabilities)

    assert missing_capabilities == set()
