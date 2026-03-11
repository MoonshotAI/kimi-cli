"""Tests for normalize_history in the dynamic_injection module."""

from __future__ import annotations

from kosong.message import ContentPart, Message, TextPart

from kimi_cli.soul.dynamic_injection import normalize_history


def _text(part: ContentPart) -> str:
    assert isinstance(part, TextPart)
    return part.text


def test_empty_history() -> None:
    assert normalize_history([]) == []


def test_single_user_message() -> None:
    msgs = [Message(role="user", content=[TextPart(text="hello")])]
    result = normalize_history(msgs)
    assert len(result) == 1
    assert result[0].role == "user"
    assert _text(result[0].content[0]) == "hello"


def test_single_assistant_message() -> None:
    msgs = [Message(role="assistant", content=[TextPart(text="hi")])]
    result = normalize_history(msgs)
    assert len(result) == 1
    assert result[0].role == "assistant"


def test_adjacent_user_messages_merged() -> None:
    msgs = [
        Message(role="user", content=[TextPart(text="A")]),
        Message(role="user", content=[TextPart(text="B")]),
    ]
    result = normalize_history(msgs)
    assert len(result) == 1
    assert result[0].role == "user"
    assert len(result[0].content) == 2
    assert _text(result[0].content[0]) == "A"
    assert _text(result[0].content[1]) == "B"


def test_three_adjacent_user_messages_merged() -> None:
    msgs = [
        Message(role="user", content=[TextPart(text="A")]),
        Message(role="user", content=[TextPart(text="B")]),
        Message(role="user", content=[TextPart(text="C")]),
    ]
    result = normalize_history(msgs)
    assert len(result) == 1
    assert len(result[0].content) == 3


def test_non_adjacent_users_not_merged() -> None:
    msgs = [
        Message(role="user", content=[TextPart(text="A")]),
        Message(role="assistant", content=[TextPart(text="X")]),
        Message(role="user", content=[TextPart(text="B")]),
    ]
    result = normalize_history(msgs)
    assert len(result) == 3
    assert result[0].role == "user"
    assert result[1].role == "assistant"
    assert result[2].role == "user"


def test_adjacent_assistant_not_merged() -> None:
    msgs = [
        Message(role="assistant", content=[TextPart(text="X")]),
        Message(role="assistant", content=[TextPart(text="Y")]),
    ]
    result = normalize_history(msgs)
    assert len(result) == 2


def test_mixed_roles_complex() -> None:
    msgs = [
        Message(role="user", content=[TextPart(text="A")]),
        Message(role="user", content=[TextPart(text="B")]),
        Message(role="assistant", content=[TextPart(text="X")]),
        Message(role="user", content=[TextPart(text="C")]),
        Message(role="user", content=[TextPart(text="D")]),
        Message(role="assistant", content=[TextPart(text="Y")]),
    ]
    result = normalize_history(msgs)
    assert len(result) == 4
    assert result[0].role == "user"
    assert len(result[0].content) == 2  # A + B merged
    assert result[1].role == "assistant"
    assert result[2].role == "user"
    assert len(result[2].content) == 2  # C + D merged
    assert result[3].role == "assistant"


def test_multipart_content_preserved() -> None:
    msgs = [
        Message(role="user", content=[TextPart(text="A"), TextPart(text="B")]),
        Message(role="user", content=[TextPart(text="C")]),
    ]
    result = normalize_history(msgs)
    assert len(result) == 1
    assert len(result[0].content) == 3
    assert _text(result[0].content[0]) == "A"
    assert _text(result[0].content[1]) == "B"
    assert _text(result[0].content[2]) == "C"
