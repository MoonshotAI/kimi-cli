"""Tests for /export and /import slash commands."""

from __future__ import annotations

from datetime import datetime

from kosong.message import Message

from kimi_cli.soul.message import system
from kimi_cli.utils.export import (
    _IMPORTABLE_EXTENSIONS,
    _build_export_markdown,
    _extract_tool_call_hint,
    _format_content_part_md,
    _format_tool_call_md,
    _format_tool_result_md,
    _group_into_turns,
    _is_checkpoint_message,
    _is_importable_file,
    _stringify_content_parts,
    _stringify_context_history,
    _stringify_tool_calls,
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
# _stringify_context_history
# ---------------------------------------------------------------------------


class TestStringifyContextHistory:
    def test_simple_user_assistant(self) -> None:
        history: list[Message] = [
            Message(role="user", content=[TextPart(text="What is 1+1?")]),
            Message(role="assistant", content=[TextPart(text="2")]),
        ]
        result = _stringify_context_history(history)
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
        result = _stringify_context_history(history)
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
        result = _stringify_context_history(history)
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
        result = _stringify_context_history(history)
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
        result = _stringify_context_history(history)
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
        result = _stringify_context_history(history)

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
        result = _stringify_context_history(history)
        assert "[ASSISTANT]" not in result
        assert "Real message" in result

    def test_system_role_preserved(self) -> None:
        history: list[Message] = [
            Message(role="system", content=[TextPart(text="You are a helpful assistant")]),
        ]
        result = _stringify_context_history(history)
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


# ---------------------------------------------------------------------------
# _build_export_markdown
# ---------------------------------------------------------------------------


class TestBuildExportMarkdown:
    def test_contains_yaml_frontmatter(self) -> None:
        history = [
            Message(role="user", content=[TextPart(text="Hello")]),
            Message(role="assistant", content=[TextPart(text="Hi")]),
        ]
        now = datetime(2026, 3, 2, 12, 0, 0)
        result = _build_export_markdown(
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
        result = _build_export_markdown(
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
        result = _build_export_markdown(
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


# ---------------------------------------------------------------------------
# _is_importable_file
# ---------------------------------------------------------------------------


class TestIsImportableFile:
    def test_markdown(self) -> None:
        assert _is_importable_file("notes.md") is True

    def test_txt(self) -> None:
        assert _is_importable_file("readme.txt") is True

    def test_python(self) -> None:
        assert _is_importable_file("main.py") is True

    def test_json(self) -> None:
        assert _is_importable_file("data.json") is True

    def test_log(self) -> None:
        assert _is_importable_file("server.log") is True

    def test_no_extension_accepted(self) -> None:
        assert _is_importable_file("Makefile") is True
        assert _is_importable_file("README") is True

    def test_binary_rejected(self) -> None:
        assert _is_importable_file("photo.png") is False
        assert _is_importable_file("archive.zip") is False
        assert _is_importable_file("document.pdf") is False
        assert _is_importable_file("binary.exe") is False
        assert _is_importable_file("image.jpg") is False

    def test_case_insensitive(self) -> None:
        assert _is_importable_file("README.MD") is True
        assert _is_importable_file("config.YAML") is True
        assert _is_importable_file("style.CSS") is True

    def test_importable_extensions_is_frozenset(self) -> None:
        assert isinstance(_IMPORTABLE_EXTENSIONS, frozenset)
