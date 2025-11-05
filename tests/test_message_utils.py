"""Tests for message utility functions."""

from kosong.base.message import ImageURLPart, Message, TextPart

from kimi_cli.utils.message import message_extract_text, message_stringify


def test_message_extract_text_handles_strings():
    message = Message(role="user", content="Simple text")

    assert message_extract_text(message) == "Simple text"


def test_message_extract_text_joins_text_parts():
    message = Message(
        role="user",
        content=[
            TextPart(text="Hello"),
            ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/image.jpg")),
            TextPart(text="World"),
        ],
    )

    assert message_extract_text(message) == "Hello\nWorld"


def test_message_stringify_plain_text():
    message = Message(role="user", content="Simple text")

    assert message_stringify(message) == "Simple text"


def test_message_stringify_collapses_large_text_by_default():
    large_text = "\n".join(["line"] * 60)
    message = Message(role="user", content=large_text)

    assert message_stringify(message) == "[pasted 60 lines]"


def test_message_stringify_respects_replay_context():
    large_text = "\n".join(["line"] * 60)
    message = Message(role="user", content=large_text)

    assert message_stringify(message, context="replay") == large_text


def test_message_stringify_handles_mixed_parts():
    message = Message(
        role="user",
        content=[
            TextPart(text="Hello"),
            ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/image.jpg")),
            TextPart(text="\n".join(["line"] * 60)),
        ],
    )

    assert message_stringify(message) == "Hello[image_url][pasted 60 lines]"
