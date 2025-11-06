"""Tests for message utility functions."""

from kosong.base.message import ImageURLPart, Message, TextPart

from kimi_cli.utils.message import message_extract_text, message_stringify


def test_extract_text_from_string_content():
    """Test extracting text from message with string content."""
    message = Message(role="user", content="Simple text")
    result = message_extract_text(message)

    assert result == "Simple text"


def test_extract_text_from_content_parts():
    """Test extracting text from message with content parts."""
    text_part1 = TextPart(text="Hello")
    text_part2 = TextPart(text="World")
    image_part = ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/image.jpg"))

    message = Message(role="user", content=[text_part1, image_part, text_part2])
    result = message_extract_text(message)

    assert result == "Hello\nWorld"


def test_extract_text_from_empty_content_parts():
    """Test extracting text from message with no text parts."""
    image_part = ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/image.jpg"))
    message = Message(role="user", content=[image_part])
    result = message_extract_text(message)

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

    assert result == "Hello[image_url]World"


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

    assert result == "[image_url][image_url]"


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
    result = message_extract_text(message)

    assert result == ""


# New tests for large paste collapse feature
def test_stringify_collapses_large_text_by_default():
    """Test that large text is collapsed in default context."""
    large_text = "\n".join(["line"] * 60)
    message = Message(role="user", content=large_text)
    result = message_stringify(message)

    assert result == "[pasted 60 lines]"


def test_stringify_respects_replay_context():
    """Test that large text is shown in full in replay context."""
    large_text = "\n".join(["line"] * 60)
    message = Message(role="user", content=large_text)
    result = message_stringify(message, context="replay")

    assert result == large_text


def test_stringify_handles_mixed_parts_with_large_text():
    """Test mixed content with large text part and image."""
    message = Message(
        role="user",
        content=[
            TextPart(text="Hello"),
            ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/image.jpg")),
            TextPart(text="\n".join(["line"] * 60)),
        ],
    )
    result = message_stringify(message)

    assert result == "Hello[image_url][pasted 60 lines]"
