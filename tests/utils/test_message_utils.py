"""Tests for message utility functions."""

from __future__ import annotations

from kosong.message import Message

from kimi_cli.utils.message import message_stringify, user_input_to_text
from kimi_cli.wire.types import ImageURLPart, TextPart


def test_user_input_to_text_from_string():
    """A plain string is returned unchanged."""
    assert user_input_to_text("hello world") == "hello world"


def test_user_input_to_text_from_content_parts():
    """Structured content (e.g. from the shell UI) yields its text, not ''."""
    user_input = [TextPart(text="hello"), TextPart(text="world")]
    assert user_input_to_text(user_input) == "hello world"


def test_user_input_to_text_ignores_non_text_parts():
    """Non-text parts are skipped when extracting the text."""
    image_part = ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/image.jpg"))
    user_input = [TextPart(text="describe"), image_part, TextPart(text="this")]
    assert user_input_to_text(user_input) == "describe this"


def test_user_input_to_text_from_empty_parts():
    """No text parts yields an empty string."""
    assert user_input_to_text([]) == ""


def test_extract_text_from_string_content():
    """Test extracting text from message with string content."""
    message = Message(role="user", content="Simple text")
    result = message.extract_text(sep="\n")

    assert result == "Simple text"


def test_extract_text_from_content_parts():
    """Test extracting text from message with content parts."""
    text_part1 = TextPart(text="Hello")
    text_part2 = TextPart(text="World")
    image_part = ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/image.jpg"))

    message = Message(role="user", content=[text_part1, image_part, text_part2])
    result = message.extract_text(sep="\n")

    assert result == "Hello\nWorld"


def test_extract_text_from_empty_content_parts():
    """Test extracting text from message with no text parts."""
    image_part = ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/image.jpg"))
    message = Message(role="user", content=[image_part])
    result = message.extract_text(sep="\n")

    assert result == ""


def test_stringify_string_content():
    """Test stringifying message with string content."""
    message = Message(role="user", content="Simple text")
    result = message_stringify(message)

    assert result == "Simple text"


def test_stringify_text_parts():
    """Test stringifying message with text parts."""
    text_part1 = TextPart(text="Hello")
    text_part2 = TextPart(text="World")
    message = Message(role="user", content=[text_part1, text_part2])
    result = message_stringify(message)

    assert result == "HelloWorld"


def test_stringify_mixed_parts():
    """Test stringifying message with text and image parts."""
    text_part1 = TextPart(text="Hello")
    image_part = ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/image.jpg"))
    text_part2 = TextPart(text="World")

    message = Message(role="user", content=[text_part1, image_part, text_part2])
    result = message_stringify(message)

    assert result == "Hello[image]World"


def test_stringify_only_image_parts():
    """Test stringifying message with only image parts."""
    image_part1 = ImageURLPart(
        image_url=ImageURLPart.ImageURL(url="https://example.com/image1.jpg")
    )
    image_part2 = ImageURLPart(
        image_url=ImageURLPart.ImageURL(url="https://example.com/image2.jpg")
    )

    message = Message(role="user", content=[image_part1, image_part2])
    result = message_stringify(message)

    assert result == "[image][image]"


def test_stringify_empty_string():
    """Test stringifying message with empty string content."""
    message = Message(role="user", content="")
    result = message_stringify(message)

    assert result == ""


def test_stringify_empty_parts():
    """Test stringifying message with empty content parts."""
    message = Message(role="user", content=[])
    result = message_stringify(message)

    assert result == ""


def test_extract_text_from_empty_string():
    """Test extracting text from empty string content."""
    message = Message(role="user", content="")
    result = message.extract_text(sep="\n")

    assert result == ""
