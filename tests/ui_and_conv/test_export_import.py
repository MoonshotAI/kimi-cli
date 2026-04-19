"""Tests for /export and /import slash commands."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from kosong.message import Message

from kimi_cli.soul.message import system, system_reminder
from kimi_cli.utils.export import (
    _IMPORTABLE_EXTENSIONS,
    _extract_tool_call_hint,
    _format_content_part_md,
    _format_tool_call_md,
    _format_tool_result_md,
    _group_into_turns,
    _is_checkpoint_message,
    _stringify_content_parts,
    _stringify_tool_calls,
    build_export_markdown,
    build_import_message,
    is_importable_file,
    perform_export,
    perform_import,
    resolve_import_source,
    stringify_context_history,
)
from kimi_cli.wire.types import (
    AudioURLPart,
    ContentPart,
    ImageURLPart,
    TextPart,
    ThinkPart,
    ToolCall,
    VideoURLPart,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_tool_call(
    call_id: str = "call_001",
    name: str = "bash",
    arguments: str | None = '{"command": "ls"}',
) -> ToolCall:
    return ToolCall(
        id=call_id,
        function=ToolCall.FunctionBody(name=name, arguments=arguments),
    )


def _make_checkpoint_message(checkpoint_id: int = 0) -> Message:
    return Message(
        role="user",
        content=[system(f"CHECKPOINT {checkpoint_id}")],
    )


def _make_system_reminder_message(text: str = "Stay focused.") -> Message:
    return Message(role="user", content=[system_reminder(text)])


def _make_notification_message(
    notification_id: str = "n1",
    category: str = "task",
    type: str = "task.failed",
) -> Message:
    return Message(
        role="user",
        content=[
            TextPart(
                text=(
                    f'<notification id="{notification_id}" category="{category}" '
                    f'type="{type}" source_kind="background_task" source_id="b0y8z5bi0">\n'
                    "Title: Background task failed\n"
                    "Severity: error\n"
                    "<task-notification>\n"
                    "Task ID: b0y8z5bi0\n"
                    "Task Type: bash\n"
                    "Status: failed\n"
                    "</task-notification>\n"
                    "</notification>"
                )
            )
        ],
    )


# ---------------------------------------------------------------------------
# _stringify_content_parts
# ---------------------------------------------------------------------------


class TestStringifyContentParts:
    def test_text_part(self) -> None:
        parts: list[ContentPart] = [TextPart(text="Hello world")]
        result = _stringify_content_parts(parts)
        assert result == "Hello world"

    def test_think_part_preserved(self) -> None:
        parts: list[ContentPart] = [ThinkPart(think="Let me analyze this...")]
        result = _stringify_content_parts(parts)
        assert "<thinking>" in result
        assert "Let me analyze this..." in result
        assert "</thinking>" in result

    def test_mixed_content(self) -> None:
        parts: list[ContentPart] = [
            ThinkPart(think="Thinking first"),
            TextPart(text="Then responding"),
        ]
        result = _stringify_content_parts(parts)
        assert "Thinking first" in result
        assert "Then responding" in result

    def test_image_placeholder(self) -> None:
        parts: list[ContentPart] = [
            ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/img.png")),
        ]
        result = _stringify_content_parts(parts)
        assert result == "[image]"

    def test_audio_placeholder(self) -> None:
        parts: list[ContentPart] = [
            AudioURLPart(audio_url=AudioURLPart.AudioURL(url="https://example.com/audio.mp3")),
        ]
        result = _stringify_content_parts(parts)
        assert result == "[audio]"

    def test_video_placeholder(self) -> None:
        parts: list[ContentPart] = [
            VideoURLPart(video_url=VideoURLPart.VideoURL(url="https://example.com/video.mp4")),
        ]
        result = _stringify_content_parts(parts)
        assert result == "[video]"

    def test_empty_text_skipped(self) -> None:
        parts: list[ContentPart] = [TextPart(text="   "), TextPart(text="Real content")]
        result = _stringify_content_parts(parts)
        assert result == "Real content"

    def test_empty_think_skipped(self) -> None:
        parts: list[ContentPart] = [ThinkPart(think="  "), TextPart(text="Response")]
        result = _stringify_content_parts(parts)
        assert result == "Response"
        assert "<thinking>" not in result


# ---------------------------------------------------------------------------
# _stringify_tool_calls
# ---------------------------------------------------------------------------


class TestStringifyToolCalls:
    def test_single_tool_call(self) -> None:
        tc = _make_tool_call(name="bash", arguments='{"command": "ls -la"}')
        result = _stringify_tool_calls([tc])
        assert "Tool Call: bash(" in result
        assert "ls -la" in result

    def test_multiple_tool_calls(self) -> None:
        tc1 = _make_tool_call(call_id="c1", name="ReadFile", arguments='{"path": "a.py"}')
        tc2 = _make_tool_call(call_id="c2", name="WriteFile", arguments='{"path": "b.py"}')
        result = _stringify_tool_calls([tc1, tc2])
        assert "Tool Call: ReadFile(" in result
        assert "Tool Call: WriteFile(" in result
        assert "a.py" in result
        assert "b.py" in result

    def test_invalid_json_arguments(self) -> None:
        tc = _make_tool_call(name="test", arguments="not valid json")
        result = _stringify_tool_calls([tc])
        assert "Tool Call: test(not valid json)" in result

    def test_none_arguments(self) -> None:
        tc = _make_tool_call(name="test", arguments=None)
        result = _stringify_tool_calls([tc])
        assert "Tool Call: test({})" in result


# ---------------------------------------------------------------------------
# stringify_context_history
# ---------------------------------------------------------------------------


class TestStringifyContextHistory:
    def test_simple_user_assistant(self) -> None:
        history: list[Message] = [
            Message(role="user", content=[TextPart(text="What is 1+1?")]),
            Message(role="assistant", content=[TextPart(text="2")]),
        ]
        result = stringify_context_history(history)
        assert "[USER]" in result
        assert "What is 1+1?" in result
        assert "[ASSISTANT]" in result
        assert "2" in result

    def test_think_part_preserved_in_history(self) -> None:
        """ThinkPart content must appear in the serialized output."""
        history: list[Message] = [
            Message(role="user", content=[TextPart(text="Explain X")]),
            Message(
                role="assistant",
                content=[
                    ThinkPart(think="Let me reason about X step by step..."),
                    TextPart(text="X is explained as follows..."),
                ],
            ),
        ]
        result = stringify_context_history(history)
        assert "Let me reason about X step by step..." in result
        assert "<thinking>" in result
        assert "X is explained as follows..." in result

    def test_tool_calls_preserved_in_history(self) -> None:
        """Tool call information must appear in the serialized output."""
        tc = _make_tool_call(name="ReadFile", arguments='{"path": "main.py"}')
        history: list[Message] = [
            Message(role="user", content=[TextPart(text="Read the file")]),
            Message(
                role="assistant",
                content=[TextPart(text="Reading the file...")],
                tool_calls=[tc],
            ),
        ]
        result = stringify_context_history(history)
        assert "Tool Call: ReadFile(" in result
        assert "main.py" in result

    def test_tool_result_preserved_in_history(self) -> None:
        """Tool result messages must appear with their call_id."""
        history: list[Message] = [
            Message(
                role="tool",
                content=[TextPart(text="file content here")],
                tool_call_id="call_001",
            ),
        ]
        result = stringify_context_history(history)
        assert "[TOOL]" in result
        assert "call_id: call_001" in result
        assert "file content here" in result

    def test_checkpoint_messages_filtered(self) -> None:
        """Checkpoint messages must not appear in the serialized output."""
        history: list[Message] = [
            Message(role="user", content=[TextPart(text="Hello")]),
            _make_checkpoint_message(0),
            Message(role="assistant", content=[TextPart(text="Hi there")]),
            _make_checkpoint_message(1),
        ]
        result = stringify_context_history(history)
        assert "CHECKPOINT" not in result
        assert "Hello" in result
        assert "Hi there" in result

    def test_full_conversation_round_trip(self) -> None:
        """A complete conversation with thinking, tool calls, and results."""
        tc = _make_tool_call(
            call_id="call_abc",
            name="bash",
            arguments='{"command": "echo hello"}',
        )
        history: list[Message] = [
            Message(role="user", content=[TextPart(text="Run echo hello")]),
            Message(
                role="assistant",
                content=[
                    ThinkPart(think="User wants to run a command"),
                    TextPart(text="I'll run that for you."),
                ],
                tool_calls=[tc],
            ),
            Message(
                role="tool",
                content=[TextPart(text="hello\n")],
                tool_call_id="call_abc",
            ),
            Message(
                role="assistant",
                content=[TextPart(text="The command output is: hello")],
            ),
        ]
        result = stringify_context_history(history)

        # All key information must be present
        assert "Run echo hello" in result  # user message
        assert "User wants to run a command" in result  # thinking
        assert "I'll run that for you." in result  # assistant text
        assert "Tool Call: bash(" in result  # tool call
        assert "echo hello" in result  # tool args
        assert "[TOOL] (call_id: call_abc)" in result  # tool result header
        assert "hello\n" in result  # tool result content
        assert "The command output is: hello" in result  # final response

    def test_empty_messages_skipped(self) -> None:
        """Messages with no content and no tool_calls should be skipped."""
        history: list[Message] = [
            Message(role="assistant", content=[TextPart(text="")]),
            Message(role="user", content=[TextPart(text="Real message")]),
        ]
        result = stringify_context_history(history)
        assert "[ASSISTANT]" not in result
        assert "Real message" in result

    def test_system_role_preserved(self) -> None:
        history: list[Message] = [
            Message(role="system", content=[TextPart(text="You are a helpful assistant")]),
        ]
        result = stringify_context_history(history)
        assert "[SYSTEM]" in result
        assert "You are a helpful assistant" in result


# ---------------------------------------------------------------------------
# _is_checkpoint_message
# ---------------------------------------------------------------------------


class TestIsCheckpointMessage:
    def test_checkpoint_detected(self) -> None:
        msg = _make_checkpoint_message(0)
        assert _is_checkpoint_message(msg) is True

    def test_regular_user_message(self) -> None:
        msg = Message(role="user", content=[TextPart(text="Hello")])
        assert _is_checkpoint_message(msg) is False

    def test_assistant_message_not_checkpoint(self) -> None:
        msg = Message(role="assistant", content=[TextPart(text="<system>CHECKPOINT 0</system>")])
        assert _is_checkpoint_message(msg) is False

    def test_multi_part_message_not_checkpoint(self) -> None:
        msg = Message(
            role="user",
            content=[
                TextPart(text="<system>CHECKPOINT 0</system>"),
                TextPart(text="extra"),
            ],
        )
        assert _is_checkpoint_message(msg) is False


# ---------------------------------------------------------------------------
# _format_content_part_md (export side)
# ---------------------------------------------------------------------------


class TestFormatContentPartMd:
    def test_text_part(self) -> None:
        result = _format_content_part_md(TextPart(text="Hello world"))
        assert result == "Hello world"

    def test_think_part_wrapped_in_details(self) -> None:
        result = _format_content_part_md(ThinkPart(think="Reasoning here"))
        assert "<details><summary>Thinking</summary>" in result
        assert "Reasoning here" in result
        assert "</details>" in result

    def test_empty_think_part_returns_empty(self) -> None:
        assert _format_content_part_md(ThinkPart(think="")) == ""
        assert _format_content_part_md(ThinkPart(think="   ")) == ""

    def test_image_placeholder(self) -> None:
        part = ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/img.png"))
        assert _format_content_part_md(part) == "[image]"

    def test_audio_placeholder(self) -> None:
        part = AudioURLPart(audio_url=AudioURLPart.AudioURL(url="https://example.com/a.mp3"))
        assert _format_content_part_md(part) == "[audio]"

    def test_video_placeholder(self) -> None:
        part = VideoURLPart(video_url=VideoURLPart.VideoURL(url="https://example.com/v.mp4"))
        assert _format_content_part_md(part) == "[video]"


# ---------------------------------------------------------------------------
# _extract_tool_call_hint
# ---------------------------------------------------------------------------


class TestExtractToolCallHint:
    def test_known_key_path(self) -> None:
        result = _extract_tool_call_hint('{"path": "/src/main.py"}')
        assert result == "/src/main.py"

    def test_known_key_command(self) -> None:
        result = _extract_tool_call_hint('{"command": "ls -la"}')
        assert result == "ls -la"

    def test_fallback_to_first_short_string(self) -> None:
        result = _extract_tool_call_hint('{"foo": "bar"}')
        assert result == "bar"

    def test_empty_on_invalid_json(self) -> None:
        assert _extract_tool_call_hint("not json") == ""

    def test_empty_on_non_dict(self) -> None:
        assert _extract_tool_call_hint("[1, 2, 3]") == ""

    def test_empty_on_no_string_values(self) -> None:
        assert _extract_tool_call_hint('{"count": 42}') == ""

    def test_long_value_truncated(self) -> None:
        long_val = "a" * 100
        result = _extract_tool_call_hint(f'{{"path": "{long_val}"}}')
        assert len(result) <= 60
        assert result.endswith("…")


# ---------------------------------------------------------------------------
# _format_tool_call_md
# ---------------------------------------------------------------------------


class TestFormatToolCallMd:
    def test_basic_tool_call(self) -> None:
        tc = _make_tool_call(call_id="c1", name="bash", arguments='{"command": "ls"}')
        result = _format_tool_call_md(tc)
        assert "#### Tool Call: bash" in result
        assert "(`ls`)" in result  # hint extracted
        assert "call_id: c1" in result
        assert "```json" in result

    def test_invalid_json_arguments(self) -> None:
        tc = _make_tool_call(name="test", arguments="not json")
        result = _format_tool_call_md(tc)
        assert "#### Tool Call: test" in result
        assert "not json" in result

    def test_no_hint_when_no_string_args(self) -> None:
        tc = _make_tool_call(name="test", arguments='{"count": 42}')
        result = _format_tool_call_md(tc)
        assert "#### Tool Call: test\n" in result  # no hint in parens


# ---------------------------------------------------------------------------
# _format_tool_result_md
# ---------------------------------------------------------------------------


class TestFormatToolResultMd:
    def test_basic_tool_result(self) -> None:
        msg = Message(
            role="tool",
            content=[TextPart(text="output text")],
            tool_call_id="c1",
        )
        result = _format_tool_result_md(msg, "bash", "ls")
        assert "<details><summary>Tool Result: bash (`ls`)</summary>" in result
        assert "call_id: c1" in result
        assert "output text" in result
        assert "</details>" in result

    def test_system_tagged_content_preserved(self) -> None:
        """Tool results with <system> tags should still include the text."""
        msg = Message(
            role="tool",
            content=[system("ERROR: command failed"), TextPart(text="stderr output")],
            tool_call_id="c2",
        )
        result = _format_tool_result_md(msg, "bash", "")
        assert "command failed" in result
        assert "stderr output" in result

    def test_no_hint(self) -> None:
        msg = Message(
            role="tool",
            content=[TextPart(text="data")],
            tool_call_id="c1",
        )
        result = _format_tool_result_md(msg, "ReadFile", "")
        assert "Tool Result: ReadFile</summary>" in result
        assert "(`" not in result


# ---------------------------------------------------------------------------
# _group_into_turns
# ---------------------------------------------------------------------------


class TestGroupIntoTurns:
    def test_single_turn(self) -> None:
        history = [
            Message(role="user", content=[TextPart(text="Hello")]),
            Message(role="assistant", content=[TextPart(text="Hi")]),
        ]
        turns = _group_into_turns(history)
        assert len(turns) == 1
        assert len(turns[0]) == 2

    def test_multiple_turns(self) -> None:
        history = [
            Message(role="user", content=[TextPart(text="Q1")]),
            Message(role="assistant", content=[TextPart(text="A1")]),
            Message(role="user", content=[TextPart(text="Q2")]),
            Message(role="assistant", content=[TextPart(text="A2")]),
        ]
        turns = _group_into_turns(history)
        assert len(turns) == 2

    def test_checkpoints_excluded_from_turns(self) -> None:
        """Checkpoint messages must be filtered out entirely during grouping."""
        history = [
            Message(role="user", content=[TextPart(text="Q1")]),
            _make_checkpoint_message(0),
            Message(role="assistant", content=[TextPart(text="A1")]),
        ]
        turns = _group_into_turns(history)
        assert len(turns) == 1
        assert len(turns[0]) == 2  # user + assistant (checkpoint filtered out)

    def test_leading_checkpoints_no_empty_turn(self) -> None:
        """Checkpoints before the first real user message must not produce an empty turn."""
        history = [
            _make_checkpoint_message(0),
            _make_checkpoint_message(1),
            Message(role="user", content=[TextPart(text="Hello")]),
            Message(role="assistant", content=[TextPart(text="Hi")]),
        ]
        turns = _group_into_turns(history)
        assert len(turns) == 1
        assert turns[0][0].role == "user"

    def test_system_messages_before_first_user(self) -> None:
        """System messages before first user message form a separate initial group."""
        history = [
            Message(role="system", content=[TextPart(text="System prompt")]),
            Message(role="user", content=[TextPart(text="Hello")]),
            Message(role="assistant", content=[TextPart(text="Hi")]),
        ]
        turns = _group_into_turns(history)
        assert len(turns) == 2
        # First group: system message only
        assert turns[0][0].role == "system"
        # Second group: user + assistant
        assert turns[1][0].role == "user"
        assert len(turns[1]) == 2

    def test_system_reminders_excluded_from_turns(self) -> None:
        history = [
            Message(role="user", content=[TextPart(text="Q1")]),
            Message(role="assistant", content=[TextPart(text="A1")]),
            _make_system_reminder_message("Do not split the turn."),
            Message(role="assistant", content=[TextPart(text="A2")]),
        ]

        turns = _group_into_turns(history)

        assert len(turns) == 1
        assert [msg.extract_text(" ") for msg in turns[0]] == ["Q1", "A1", "A2"]

    def test_notifications_excluded_from_turns(self) -> None:
        """Notification messages must be filtered out entirely during grouping."""
        history = [
            Message(role="user", content=[TextPart(text="Q1")]),
            Message(role="assistant", content=[TextPart(text="A1")]),
            _make_notification_message("n1"),
            Message(role="assistant", content=[TextPart(text="A2")]),
        ]

        turns = _group_into_turns(history)

        assert len(turns) == 1
        assert [msg.extract_text(" ") for msg in turns[0]] == ["Q1", "A1", "A2"]

    def test_leading_notifications_no_empty_turn(self) -> None:
        """Notifications before the first real user message must not produce an empty turn."""
        history = [
            _make_notification_message("n1"),
            _make_notification_message("n2"),
            Message(role="user", content=[TextPart(text="Hello")]),
            Message(role="assistant", content=[TextPart(text="Hi")]),
        ]
        turns = _group_into_turns(history)
        assert len(turns) == 1
        assert turns[0][0].role == "user"
        assert turns[0][0].extract_text(" ") == "Hello"

    def test_notification_between_turns_does_not_split(self) -> None:
        """A notification between two turns should not create a spurious turn."""
        history = [
            Message(role="user", content=[TextPart(text="Q1")]),
            Message(role="assistant", content=[TextPart(text="A1")]),
            _make_notification_message("n1"),
            Message(role="user", content=[TextPart(text="Q2")]),
            Message(role="assistant", content=[TextPart(text="A2")]),
        ]
        turns = _group_into_turns(history)
        assert len(turns) == 2
        assert turns[0][0].extract_text(" ") == "Q1"
        assert turns[1][0].extract_text(" ") == "Q2"

    def test_plain_steer_user_message_starts_new_turn(self) -> None:
        history = [
            Message(role="user", content=[TextPart(text="Q1")]),
            Message(role="assistant", content=[TextPart(text="A1")]),
            Message(role="user", content=[TextPart(text="A steer follow-up")]),
            Message(role="assistant", content=[TextPart(text="A2")]),
        ]

        turns = _group_into_turns(history)

        assert len(turns) == 2
        assert turns[1][0].extract_text(" ") == "A steer follow-up"


# ---------------------------------------------------------------------------
# build_export_markdown
# ---------------------------------------------------------------------------


class TestBuildExportMarkdown:
    def test_contains_yaml_frontmatter(self) -> None:
        history = [
            Message(role="user", content=[TextPart(text="Hello")]),
            Message(role="assistant", content=[TextPart(text="Hi")]),
        ]
        now = datetime(2026, 3, 2, 12, 0, 0)
        result = build_export_markdown(
            session_id="test-session",
            work_dir="/tmp/work",
            history=history,
            token_count=1000,
            now=now,
        )
        assert "session_id: test-session" in result
        assert "exported_at: 2026-03-02T12:00:00" in result
        assert "work_dir: /tmp/work" in result
        assert "message_count: 2" in result
        assert "token_count: 1000" in result

    def test_contains_overview_and_turns(self) -> None:
        history = [
            Message(role="user", content=[TextPart(text="What is 2+2?")]),
            Message(role="assistant", content=[TextPart(text="4")]),
        ]
        now = datetime(2026, 1, 1)
        result = build_export_markdown(
            session_id="s1",
            work_dir="/w",
            history=history,
            token_count=100,
            now=now,
        )
        assert "## Overview" in result
        assert "## Turn 1" in result
        assert "### User" in result
        assert "What is 2+2?" in result
        assert "### Assistant" in result
        assert "4" in result

    def test_tool_calls_in_export(self) -> None:
        """Full round-trip: user -> assistant with tool call -> tool result -> final."""
        tc = _make_tool_call(call_id="c1", name="bash", arguments='{"command": "echo hi"}')
        history = [
            Message(role="user", content=[TextPart(text="Run echo hi")]),
            Message(
                role="assistant",
                content=[TextPart(text="Running...")],
                tool_calls=[tc],
            ),
            Message(
                role="tool",
                content=[TextPart(text="hi\n")],
                tool_call_id="c1",
            ),
            Message(
                role="assistant",
                content=[TextPart(text="Done.")],
            ),
        ]
        now = datetime(2026, 1, 1)
        result = build_export_markdown(
            session_id="s1",
            work_dir="/w",
            history=history,
            token_count=500,
            now=now,
        )
        assert "Tool Call: bash" in result
        assert "echo hi" in result
        assert "Tool Result: bash" in result
        assert "hi\n" in result
        assert "Done." in result

    def test_system_reminders_are_omitted_from_export_and_topic(self) -> None:
        history = [
            _make_system_reminder_message("Never show this reminder."),
            Message(role="user", content=[TextPart(text="Real question")]),
            Message(role="assistant", content=[TextPart(text="Real answer")]),
        ]
        now = datetime(2026, 1, 1)

        result = build_export_markdown(
            session_id="s1",
            work_dir="/w",
            history=history,
            token_count=100,
            now=now,
        )

        assert "Never show this reminder." not in result
        assert "- **Topic**: Real question" in result

    def test_plain_steer_is_included_in_export(self) -> None:
        history = [
            Message(role="user", content=[TextPart(text="Original question")]),
            Message(role="assistant", content=[TextPart(text="First answer")]),
            Message(role="user", content=[TextPart(text="A steer follow-up")]),
            Message(role="assistant", content=[TextPart(text="Second answer")]),
        ]
        now = datetime(2026, 1, 1)

        result = build_export_markdown(
            session_id="s1",
            work_dir="/w",
            history=history,
            token_count=100,
            now=now,
        )

        assert "A steer follow-up" in result
        assert "## Turn 2" in result

    def test_stringify_context_history_skips_system_reminders(self) -> None:
        history = [
            _make_system_reminder_message("Never show this reminder."),
            Message(role="user", content=[TextPart(text="Hello")]),
            Message(role="assistant", content=[TextPart(text="Hi")]),
        ]

        result = stringify_context_history(history)

        assert "Never show this reminder." not in result
        assert "[USER]\nHello" in result

    def test_stringify_context_history_skips_notifications(self) -> None:
        history = [
            _make_notification_message("n1"),
            Message(role="user", content=[TextPart(text="Hello")]),
            Message(role="assistant", content=[TextPart(text="Hi")]),
        ]

        result = stringify_context_history(history)

        assert "<notification" not in result
        assert "<task-notification>" not in result
        assert "Background task failed" not in result
        assert "[USER]\nHello" in result

    def test_export_markdown_excludes_notifications(self) -> None:
        """Notification messages must not appear in exported markdown."""
        history = [
            Message(role="user", content=[TextPart(text="Real question")]),
            Message(role="assistant", content=[TextPart(text="Answer")]),
            _make_notification_message("n1"),
            Message(role="assistant", content=[TextPart(text="Follow-up")]),
        ]
        now = datetime(2026, 1, 1)

        result = build_export_markdown(
            session_id="s1",
            work_dir="/w",
            history=history,
            token_count=100,
            now=now,
        )

        assert "<notification" not in result
        assert "<task-notification>" not in result
        assert "Real question" in result


# ---------------------------------------------------------------------------
# is_importable_file
# ---------------------------------------------------------------------------


class TestIsImportableFile:
    def test_markdown(self) -> None:
        assert is_importable_file("notes.md") is True

    def test_txt(self) -> None:
        assert is_importable_file("readme.txt") is True

    def test_python(self) -> None:
        assert is_importable_file("main.py") is True

    def test_json(self) -> None:
        assert is_importable_file("data.json") is True

    def test_log(self) -> None:
        assert is_importable_file("server.log") is True

    def test_no_extension_accepted(self) -> None:
        assert is_importable_file("Makefile") is True
        assert is_importable_file("README") is True

    def test_binary_rejected(self) -> None:
        assert is_importable_file("photo.png") is False
        assert is_importable_file("archive.zip") is False
        assert is_importable_file("document.pdf") is False
        assert is_importable_file("binary.exe") is False
        assert is_importable_file("image.jpg") is False

    def test_case_insensitive(self) -> None:
        assert is_importable_file("README.MD") is True
        assert is_importable_file("config.YAML") is True
        assert is_importable_file("style.CSS") is True

    def test_importable_extensions_is_frozenset(self) -> None:
        assert isinstance(_IMPORTABLE_EXTENSIONS, frozenset)


# ---------------------------------------------------------------------------
# perform_export
# ---------------------------------------------------------------------------

_SIMPLE_HISTORY = [
    Message(role="user", content=[TextPart(text="Hello")]),
    Message(role="assistant", content=[TextPart(text="Hi!")]),
]


class TestPerformExport:
    async def test_empty_history_returns_error(self, tmp_path: Path) -> None:
        result = await perform_export(
            history=[],
            session_id="abc12345",
            work_dir="/tmp",
            token_count=0,
            args="",
            default_dir=tmp_path,
        )
        assert result == "No messages to export."

    async def test_writes_to_specified_file(self, tmp_path: Path) -> None:
        output = tmp_path / "my-export.md"
        result = await perform_export(
            history=_SIMPLE_HISTORY,
            session_id="abc12345",
            work_dir="/tmp",
            token_count=100,
            args=str(output),
            default_dir=tmp_path,
        )
        assert isinstance(result, tuple)
        path, count = result
        assert path == output
        assert count == 2
        assert output.exists()
        content = output.read_text()
        assert "# Kimi Session Export" in content
        assert "Hello" in content

    async def test_uses_default_dir_when_no_args(self, tmp_path: Path) -> None:
        result = await perform_export(
            history=_SIMPLE_HISTORY,
            session_id="abc12345",
            work_dir="/tmp",
            token_count=100,
            args="",
            default_dir=tmp_path,
        )
        assert isinstance(result, tuple)
        path, _ = result
        assert path.parent == tmp_path
        assert path.name.startswith("kimi-export-abc12345")
        assert path.name.endswith(".md")

    async def test_dir_arg_appends_default_name(self, tmp_path: Path) -> None:
        result = await perform_export(
            history=_SIMPLE_HISTORY,
            session_id="abc12345",
            work_dir="/tmp",
            token_count=100,
            args=str(tmp_path),
            default_dir=tmp_path,
        )
        assert isinstance(result, tuple)
        path, _ = result
        assert path.parent == tmp_path
        assert path.name.startswith("kimi-export-abc12345")

    async def test_trailing_separator_uses_directory_semantics_when_missing(
        self, tmp_path: Path
    ) -> None:
        export_dir = tmp_path / "exports"
        result = await perform_export(
            history=_SIMPLE_HISTORY,
            session_id="abc12345",
            work_dir="/tmp",
            token_count=100,
            args=f"{export_dir}/",
            default_dir=tmp_path,
        )
        assert isinstance(result, tuple)
        path, _ = result
        assert path.parent == export_dir
        assert path.name.startswith("kimi-export-abc12345")
        assert export_dir.exists() and export_dir.is_dir()
        assert path.exists()

    async def test_creates_parent_dirs(self, tmp_path: Path) -> None:
        nested = tmp_path / "a" / "b" / "export.md"
        result = await perform_export(
            history=_SIMPLE_HISTORY,
            session_id="abc12345",
            work_dir="/tmp",
            token_count=100,
            args=str(nested),
            default_dir=tmp_path,
        )
        assert isinstance(result, tuple)
        assert nested.exists()

    async def test_write_error_returns_message(self, tmp_path: Path) -> None:
        # Point to a path where parent cannot be created (file masquerading as dir)
        blocker = tmp_path / "blocker"
        blocker.write_text("x")
        bad_path = blocker / "sub" / "export.md"
        result = await perform_export(
            history=_SIMPLE_HISTORY,
            session_id="abc12345",
            work_dir="/tmp",
            token_count=100,
            args=str(bad_path),
            default_dir=tmp_path,
        )
        assert isinstance(result, str)
        assert "Failed to write export file" in result


# ---------------------------------------------------------------------------
# resolve_import_source
# ---------------------------------------------------------------------------


class TestResolveImportSource:
    async def test_directory_returns_error(self, tmp_path: Path) -> None:
        target_dir = tmp_path / "some-dir"
        target_dir.mkdir()
        result = await resolve_import_source(str(target_dir), "curr-id", tmp_path)  # type: ignore[arg-type]
        assert isinstance(result, str)
        assert "directory" in result.lower()

    async def test_unsupported_file_type_returns_error(self, tmp_path: Path) -> None:
        img = tmp_path / "photo.png"
        img.write_bytes(b"\x89PNG")
        result = await resolve_import_source(str(img), "curr-id", tmp_path)  # type: ignore[arg-type]
        assert isinstance(result, str)
        assert "Unsupported file type" in result

    async def test_empty_file_returns_error(self, tmp_path: Path) -> None:
        empty = tmp_path / "empty.md"
        empty.write_text("   \n  ")
        result = await resolve_import_source(str(empty), "curr-id", tmp_path)  # type: ignore[arg-type]
        assert isinstance(result, str)
        assert "empty" in result.lower()

    async def test_binary_content_returns_error(self, tmp_path: Path) -> None:
        bad = tmp_path / "data.txt"
        bad.write_bytes(b"\xff\xfe" + b"\x00" * 100)
        result = await resolve_import_source(str(bad), "curr-id", tmp_path)  # type: ignore[arg-type]
        assert isinstance(result, str)
        assert "UTF-8" in result

    async def test_self_import_returns_error(self, tmp_path: Path) -> None:
        result = await resolve_import_source("curr-id", "curr-id", tmp_path)  # type: ignore[arg-type]
        assert isinstance(result, str)
        assert "Cannot import the current session" in result

    async def test_nonexistent_session_returns_error(self, tmp_path: Path, monkeypatch) -> None:
        from kimi_cli.session import Session

        async def fake_find(_work_dir, _target):
            return None

        monkeypatch.setattr(Session, "find", fake_find)
        result = await resolve_import_source("no-such-id", "curr-id", tmp_path)  # type: ignore[arg-type]
        assert isinstance(result, str)
        assert "not a valid file path or session ID" in result

    async def test_file_too_large_returns_error(self, tmp_path: Path, monkeypatch) -> None:
        import kimi_cli.utils.export as export_mod

        monkeypatch.setattr(export_mod, "MAX_IMPORT_SIZE", 10)  # 10 bytes
        big = tmp_path / "big.md"
        big.write_text("x" * 100, encoding="utf-8")
        result = await resolve_import_source(str(big), "curr-id", tmp_path)  # type: ignore[arg-type]
        assert isinstance(result, str)
        assert "too large" in result.lower()

    async def test_session_content_too_large_returns_error(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        import kimi_cli.utils.export as export_mod
        from kimi_cli.session import Session

        # Mock Session.find to return a fake session
        fake_session = type("FakeSession", (), {"context_file": tmp_path / "ctx.jsonl"})()

        async def fake_find(_work_dir, _target):
            return fake_session

        monkeypatch.setattr(Session, "find", fake_find)

        # Mock Context to return a large history
        big_text = "x" * 200
        fake_history = [Message(role="user", content=[TextPart(text=big_text)])]

        class FakeContext:
            def __init__(self, _path):
                self.history = fake_history

            async def restore(self):
                return True

        from kimi_cli.soul import context as context_mod

        monkeypatch.setattr(context_mod, "Context", FakeContext)
        monkeypatch.setattr(export_mod, "MAX_IMPORT_SIZE", 10)  # 10 bytes

        result = await resolve_import_source("other-id", "curr-id", tmp_path)  # type: ignore[arg-type]
        assert isinstance(result, str)
        assert "too large" in result.lower()

    async def test_session_restore_failure_returns_error(self, tmp_path: Path, monkeypatch) -> None:
        from kimi_cli.session import Session
        from kimi_cli.soul import context as context_mod

        fake_session = type("FakeSession", (), {"context_file": tmp_path / "ctx.jsonl"})()

        async def fake_find(_work_dir, _target):
            return fake_session

        monkeypatch.setattr(Session, "find", fake_find)

        class FailingContext:
            def __init__(self, _path):
                self.history = []

            async def restore(self):
                raise RuntimeError("corrupt context file")

        monkeypatch.setattr(context_mod, "Context", FailingContext)

        result = await resolve_import_source("other-id", "curr-id", tmp_path)  # type: ignore[arg-type]
        assert isinstance(result, str)
        assert "Failed to load source session" in result

    async def test_successful_file_import(self, tmp_path: Path) -> None:
        src = tmp_path / "context.md"
        src.write_text("some important context", encoding="utf-8")
        result = await resolve_import_source(str(src), "curr-id", tmp_path)  # type: ignore[arg-type]
        assert isinstance(result, tuple)
        content, source_desc = result
        assert content == "some important context"
        assert "context.md" in source_desc


# ---------------------------------------------------------------------------
# perform_export — edge cases
# ---------------------------------------------------------------------------


class TestPerformExportRelativePath:
    async def test_relative_path_anchored_to_default_dir(self, tmp_path: Path) -> None:
        """A relative output path must resolve against default_dir, not process CWD."""
        work = tmp_path / "project"
        work.mkdir()
        result = await perform_export(
            history=_SIMPLE_HISTORY,
            session_id="abc12345",
            work_dir=str(work),
            token_count=100,
            args="subdir/my-export.md",
            default_dir=work,
        )
        assert isinstance(result, tuple)
        path, _ = result
        assert path == work / "subdir" / "my-export.md"
        assert path.exists()

    async def test_absolute_path_not_affected(self, tmp_path: Path) -> None:
        """Absolute paths must not be re-anchored to default_dir."""
        work = tmp_path / "project"
        work.mkdir()
        abs_output = tmp_path / "elsewhere" / "out.md"
        result = await perform_export(
            history=_SIMPLE_HISTORY,
            session_id="abc12345",
            work_dir=str(work),
            token_count=100,
            args=str(abs_output),
            default_dir=work,
        )
        assert isinstance(result, tuple)
        path, _ = result
        assert path == abs_output
        assert path.exists()


class TestResolveImportRelativePath:
    async def test_relative_path_anchored_to_work_dir(self, tmp_path: Path) -> None:
        """A relative import path must resolve against work_dir, not process CWD."""
        work = tmp_path / "project"
        work.mkdir()
        src = work / "notes.md"
        src.write_text("important notes", encoding="utf-8")
        result = await resolve_import_source("notes.md", "curr-id", work)  # type: ignore[arg-type]
        assert isinstance(result, tuple)
        content, desc = result
        assert content == "important notes"
        assert "notes.md" in desc

    async def test_absolute_path_not_affected(self, tmp_path: Path) -> None:
        """Absolute paths must not be re-anchored to work_dir."""
        work = tmp_path / "project"
        work.mkdir()
        outside = tmp_path / "other" / "data.txt"
        outside.parent.mkdir(parents=True)
        outside.write_text("external data", encoding="utf-8")
        result = await resolve_import_source(str(outside), "curr-id", work)  # type: ignore[arg-type]
        assert isinstance(result, tuple)
        content, _ = result
        assert content == "external data"


class TestPerformExportEdgeCases:
    async def test_checkpoint_only_history_still_exports(self, tmp_path: Path) -> None:
        """History with only checkpoint messages should still export (they are filtered in turns)."""
        from kimi_cli.soul.message import system as sys_msg

        history = [
            Message(role="user", content=[sys_msg("CHECKPOINT 0")]),
            Message(role="user", content=[sys_msg("CHECKPOINT 1")]),
        ]
        result = await perform_export(
            history=history,
            session_id="abc12345",
            work_dir="/tmp",
            token_count=0,
            args="",
            default_dir=tmp_path,
        )
        # Not empty (history has 2 messages), but turns will be empty
        assert isinstance(result, tuple)
        path, count = result
        assert count == 2
        content = path.read_text()
        assert "# Kimi Session Export" in content


# ---------------------------------------------------------------------------
# build_import_message
# ---------------------------------------------------------------------------


class TestBuildImportMessage:
    def test_returns_user_message_with_expected_structure(self) -> None:
        msg = build_import_message("hello world", "file 'test.md'")
        assert msg.role == "user"
        assert len(msg.content) == 2

        # First part is a system hint
        first = msg.content[0]
        assert isinstance(first, TextPart)
        assert "imported context" in first.text.lower()

        # Second part contains the wrapped content
        second = msg.content[1]
        assert isinstance(second, TextPart)
        assert "<imported_context source=\"file 'test.md'\">" in second.text
        assert "hello world" in second.text
        assert "</imported_context>" in second.text


# ---------------------------------------------------------------------------
# perform_import
# ---------------------------------------------------------------------------


def _make_mock_context(token_count: int = 0):
    """Create a minimal mock context for perform_import tests."""
    from unittest.mock import AsyncMock

    ctx = AsyncMock()
    ctx.token_count = token_count
    return ctx


class TestPerformImport:
    async def test_file_exceeding_model_context_budget_returns_error(self, tmp_path: Path) -> None:
        src = tmp_path / "context.md"
        src.write_text("x" * 2000, encoding="utf-8")
        ctx = _make_mock_context(token_count=0)
        result = await perform_import(
            str(src),
            "curr-id",
            tmp_path,  # type: ignore[arg-type]
            context=ctx,
            max_context_size=128,
        )
        assert isinstance(result, str)
        assert "model context" in result.lower()
        assert "import tokens" in result.lower()
        # Context must NOT be mutated on failure.
        ctx.append_message.assert_not_awaited()
        ctx.update_token_count.assert_not_awaited()

    async def test_file_within_model_context_budget_succeeds(self, tmp_path: Path) -> None:
        src = tmp_path / "small.md"
        src.write_text("small context", encoding="utf-8")
        ctx = _make_mock_context(token_count=0)
        result = await perform_import(
            str(src),
            "curr-id",
            tmp_path,  # type: ignore[arg-type]
            context=ctx,
            max_context_size=4096,
        )
        assert isinstance(result, tuple)
        source_desc, content_len = result
        assert source_desc == "file 'small.md'"
        assert content_len == len("small context")
        ctx.append_message.assert_awaited_once()
        ctx.update_token_count.assert_awaited_once()

    async def test_existing_context_pushes_import_over_budget(self, tmp_path: Path) -> None:
        """Import that fits alone but exceeds budget with existing context tokens."""
        src = tmp_path / "medium.md"
        src.write_text("a" * 100, encoding="utf-8")
        # current_token_count near the limit — should fail.
        ctx = _make_mock_context(token_count=180)
        result = await perform_import(
            str(src),
            "curr-id",
            tmp_path,  # type: ignore[arg-type]
            context=ctx,
            max_context_size=200,
        )
        assert isinstance(result, str)
        assert "model context" in result.lower()
        assert "existing" in result.lower()
        ctx.append_message.assert_not_awaited()

    async def test_session_exceeding_model_context_budget_returns_error(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        """Session import that exceeds model context budget is rejected."""
        from kimi_cli.session import Session
        from kimi_cli.soul import context as context_mod

        fake_session = type("FakeSession", (), {"context_file": tmp_path / "ctx.jsonl"})()

        async def fake_find(_work_dir, _target):
            return fake_session

        monkeypatch.setattr(Session, "find", fake_find)

        big_text = "x" * 2000
        fake_history = [Message(role="user", content=[TextPart(text=big_text)])]

        class FakeContext:
            def __init__(self, _path):
                self.history = fake_history

            async def restore(self):
                return True

        monkeypatch.setattr(context_mod, "Context", FakeContext)

        ctx = _make_mock_context(token_count=0)
        result = await perform_import(
            "other-id",
            "curr-id",
            tmp_path,  # type: ignore[arg-type]
            context=ctx,
            max_context_size=128,
        )
        assert isinstance(result, str)
        assert "model context" in result.lower()
        ctx.append_message.assert_not_awaited()

    async def test_returns_raw_content_len(self, tmp_path: Path) -> None:
        """content_len must equal the raw content length, not the wrapped message."""
        src = tmp_path / "data.txt"
        raw = "hello world"
        src.write_text(raw, encoding="utf-8")
        ctx = _make_mock_context(token_count=0)
        result = await perform_import(
            str(src),
            "curr-id",
            tmp_path,  # type: ignore[arg-type]
            context=ctx,
        )
        assert isinstance(result, tuple)
        _desc, content_len = result
        assert content_len == len(raw)
