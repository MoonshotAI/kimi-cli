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


def test_stringify_small_text_not_collapsed():
    """Test that small text is not collapsed."""
    message = Message(role="user", content="Hello world this is a short message")
    result = message_stringify(message)

    assert result == "Hello world this is a short message"


def test_stringify_large_text_collapsed_in_default_context():
    """Test that large text is collapsed in default/echo context."""
    # Create text with 400 words (above default threshold of 300)
    large_text = " ".join(["word"] * 400)
    message = Message(role="user", content=large_text)
    result = message_stringify(message)

    assert result == "📋 pasted 400 words"


def test_stringify_large_text_full_in_replay_context():
    """Test that large text is shown in full in replay context."""
    large_text = " ".join(["word"] * 400)
    message = Message(role="user", content=large_text)
    result = message_stringify(message, context="replay")

    assert result == large_text


def test_stringify_boundary_at_threshold():
    """Test behavior at exact threshold boundary (300 words)."""
    text_300 = " ".join(["word"] * 300)
    text_301 = " ".join(["word"] * 301)

    # 300 words should not be collapsed (threshold is >300)
    result_300 = message_stringify(Message(role="user", content=text_300))
    assert result_300 == text_300

    # 301 words should be collapsed
    result_301 = message_stringify(Message(role="user", content=text_301))
    assert result_301 == "📋 pasted 301 words"


def test_stringify_mixed_content_with_large_text():
    """Test mixed content with large text part and image."""
    large_text = " ".join(["word"] * 400)
    text_part = TextPart(text=large_text)
    image_part = ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/image.jpg"))

    message = Message(role="user", content=[text_part, image_part])
    result = message_stringify(message)

    assert result == "📋 pasted 400 words[image_url]"


def test_stringify_multiple_text_parts_evaluated_separately():
    """Test that each text part is evaluated separately for collapsing."""
    # Two separate text parts, each large enough to collapse
    text_part1 = TextPart(text=" ".join(["word"] * 350))
    text_part2 = TextPart(text=" ".join(["word"] * 350))

    message = Message(role="user", content=[text_part1, text_part2])
    result = message_stringify(message)

    # Each part should be collapsed separately
    assert result == "📋 pasted 350 words📋 pasted 350 words"
