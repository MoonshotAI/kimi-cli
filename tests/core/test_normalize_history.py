"""Tests for normalize_history in the dynamic_injection module."""

from __future__ import annotations

from kosong.message import ContentPart, Message, TextPart, ToolCall

from kimi_cli.soul.dynamic_injection import normalize_history


def _text(part: ContentPart) -> str:
    assert isinstance(part, TextPart)
    return part.text


def _tool_call(call_id: str, name: str = "Shell") -> ToolCall:
    return ToolCall(id=call_id, function=ToolCall.FunctionBody(name=name, arguments="{}"))


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


def test_notification_messages_not_merged_with_user_messages() -> None:
    msgs = [
        Message(role="user", content=[TextPart(text="user input")]),
        Message(
            role="user",
            content=[
                TextPart(
                    text='<notification id="n1" category="task" type="task.completed">x</notification>'
                )
            ],
        ),
    ]
    result = normalize_history(msgs)
    assert len(result) == 2


# ---------------------------------------------------------------------------
# Orphan tool_call repair (regression #2336)
# ---------------------------------------------------------------------------


def test_orphan_tool_call_synthesized_when_followed_by_user() -> None:
    """A persisted assistant message whose tool response was lost must
    not break the next API call -- a placeholder tool message is inserted."""
    msgs = [
        Message(role="user", content=[TextPart(text="run it")]),
        Message(
            role="assistant",
            content=[TextPart(text="ok")],
            tool_calls=[_tool_call("Shell:206")],
        ),
        Message(role="user", content=[TextPart(text="any update?")]),
    ]
    result = normalize_history(msgs)

    assert [m.role for m in result] == ["user", "assistant", "tool", "user"]
    assert result[2].tool_call_id == "Shell:206"
    assert "interrupted" in _text(result[2].content[0])


def test_orphan_tool_call_synthesized_at_history_tail() -> None:
    """Assistant with tool_calls at the very end of history (no follower)
    should still get a placeholder so the next /resume turn is valid."""
    msgs = [
        Message(role="user", content=[TextPart(text="run it")]),
        Message(
            role="assistant",
            content=[TextPart(text="ok")],
            tool_calls=[_tool_call("Shell:1")],
        ),
    ]
    result = normalize_history(msgs)

    assert [m.role for m in result] == ["user", "assistant", "tool"]
    assert result[2].tool_call_id == "Shell:1"


def test_complete_tool_response_not_duplicated() -> None:
    """A well-formed assistant+tool pair must round-trip unchanged."""
    msgs = [
        Message(role="user", content=[TextPart(text="hi")]),
        Message(
            role="assistant",
            content=[TextPart(text="")],
            tool_calls=[_tool_call("t1")],
        ),
        Message(role="tool", content=[TextPart(text="result")], tool_call_id="t1"),
    ]
    result = normalize_history(msgs)

    assert [m.role for m in result] == ["user", "assistant", "tool"]
    assert result[2].tool_call_id == "t1"
    assert _text(result[2].content[0]) == "result"


def test_partial_orphan_only_missing_ids_synthesized() -> None:
    """When parallel tool_calls have a mix of responded/missing ids,
    only the missing ones get placeholders."""
    msgs = [
        Message(
            role="assistant",
            content=[TextPart(text="")],
            tool_calls=[_tool_call("t1"), _tool_call("t2"), _tool_call("t3")],
        ),
        Message(role="tool", content=[TextPart(text="r1")], tool_call_id="t1"),
        Message(role="tool", content=[TextPart(text="r3")], tool_call_id="t3"),
        Message(role="user", content=[TextPart(text="next")]),
    ]
    result = normalize_history(msgs)

    tool_msgs = [m for m in result if m.role == "tool"]
    assert sorted(m.tool_call_id for m in tool_msgs if m.tool_call_id) == ["t1", "t2", "t3"]

    synth = next(m for m in tool_msgs if m.tool_call_id == "t2")
    assert "interrupted" in _text(synth.content[0])


def test_multiple_assistant_tool_call_groups_independent() -> None:
    """Repair must operate per assistant message; an earlier orphan
    must not consume responses meant for a later assistant message."""
    msgs = [
        Message(
            role="assistant",
            content=[TextPart(text="")],
            tool_calls=[_tool_call("a1")],
        ),
        # a1 orphan
        Message(role="user", content=[TextPart(text="continue")]),
        Message(
            role="assistant",
            content=[TextPart(text="")],
            tool_calls=[_tool_call("a2")],
        ),
        Message(role="tool", content=[TextPart(text="ok")], tool_call_id="a2"),
    ]
    result = normalize_history(msgs)

    assert [m.role for m in result] == [
        "assistant",
        "tool",
        "user",
        "assistant",
        "tool",
    ]
    assert result[1].tool_call_id == "a1"
    assert "interrupted" in _text(result[1].content[0])
    assert result[4].tool_call_id == "a2"
    assert _text(result[4].content[0]) == "ok"


def test_assistant_without_tool_calls_untouched() -> None:
    msgs = [
        Message(role="user", content=[TextPart(text="hi")]),
        Message(role="assistant", content=[TextPart(text="hello")]),
        Message(role="user", content=[TextPart(text="bye")]),
    ]
    result = normalize_history(msgs)
    assert [m.role for m in result] == ["user", "assistant", "user"]
