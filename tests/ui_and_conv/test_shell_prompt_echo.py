from kosong.message import Message
from rich.text import Text

import kimi_cli.ui.shell as shell_module
from kimi_cli.ui.shell import Shell
from kimi_cli.ui.shell.echo import render_user_echo
from kimi_cli.ui.shell.prompt import PromptMode, UserInput
from kimi_cli.utils.slashcmd import SlashCommandCall
from kimi_cli.wire.types import AudioURLPart, ImageURLPart, TextPart, VideoURLPart


def _make_user_input(command: str, *, mode: PromptMode = PromptMode.AGENT) -> UserInput:
    return UserInput(
        mode=mode,
        command=command,
        resolved_command=command,
        content=[TextPart(text=command)],
    )


def test_echo_agent_input_prints_stringified_user_message(monkeypatch) -> None:
    printed: list[Text] = []
    monkeypatch.setattr(shell_module.console, "print", lambda text: printed.append(text))

    Shell._echo_agent_input(_make_user_input("hi"))

    assert [text.plain for text in printed] == ["✨ hi"]


def test_echo_agent_input_uses_display_command_for_placeholders(monkeypatch) -> None:
    printed: list[Text] = []
    monkeypatch.setattr(shell_module.console, "print", lambda text: printed.append(text))

    user_input = UserInput(
        mode=PromptMode.AGENT,
        command="[Pasted text #1 +3 lines]",
        resolved_command="line1\nline2\nline3",
        content=[TextPart(text="line1\nline2\nline3")],
    )

    Shell._echo_agent_input(user_input)

    assert [text.plain for text in printed] == ["✨ [Pasted text #1 +3 lines]"]


def test_render_user_echo_preserves_literal_brackets() -> None:
    rendered = render_user_echo(Message(role="user", content=[TextPart(text="[brackets]")]))

    assert rendered.plain == "✨ [brackets]"


def test_render_user_echo_preserves_image_placeholder_literal() -> None:
    rendered = render_user_echo(
        Message(
            role="user",
            content=[ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/img"))],
        )
    )

    assert rendered.plain == "✨ [image]"


def test_render_user_echo_preserves_audio_placeholder_literal() -> None:
    rendered = render_user_echo(
        Message(
            role="user",
            content=[
                AudioURLPart(
                    audio_url=AudioURLPart.AudioURL(url="https://example.com/audio", id="clip")
                )
            ],
        )
    )

    assert rendered.plain == "✨ [audio:clip]"


def test_render_user_echo_preserves_video_placeholder_literal() -> None:
    rendered = render_user_echo(
        Message(
            role="user",
            content=[
                VideoURLPart(video_url=VideoURLPart.VideoURL(url="https://example.com/video"))
            ],
        )
    )

    assert rendered.plain == "✨ [video]"


def test_render_user_echo_preserves_mixed_content_order() -> None:
    rendered = render_user_echo(
        Message(
            role="user",
            content=[
                TextPart(text="look "),
                ImageURLPart(image_url=ImageURLPart.ImageURL(url="https://example.com/img")),
                AudioURLPart(audio_url=AudioURLPart.AudioURL(url="https://example.com/audio")),
                VideoURLPart(video_url=VideoURLPart.VideoURL(url="https://example.com/video")),
            ],
        )
    )

    assert rendered.plain == "✨ look [image][audio][video]"


def test_should_echo_agent_input_for_plain_agent_message() -> None:
    assert Shell._should_echo_agent_input(_make_user_input("hi")) is True


def test_should_not_echo_agent_input_for_exit_or_slash_commands() -> None:
    assert Shell._should_echo_agent_input(_make_user_input("exit")) is False
    assert Shell._should_echo_agent_input(_make_user_input("/exit")) is False
    assert Shell._should_echo_agent_input(_make_user_input("/help")) is False


def test_hidden_slash_in_placeholder_is_not_treated_as_local_command() -> None:
    user_input = UserInput(
        mode=PromptMode.AGENT,
        command="[Pasted text #1 +3 lines]",
        resolved_command="/quit\nnot really",
        content=[TextPart(text="/quit\nnot really")],
    )

    assert Shell._should_exit_input(user_input) is False
    assert Shell._agent_slash_command_call(user_input) is None
    assert Shell._should_echo_agent_input(user_input) is True


def test_should_exit_input_is_mode_independent_for_visible_exit_commands() -> None:
    assert Shell._should_exit_input(_make_user_input("exit")) is True
    assert Shell._should_exit_input(_make_user_input("/quit")) is True
    assert Shell._should_exit_input(_make_user_input("exit", mode=PromptMode.SHELL)) is True
    assert Shell._should_exit_input(_make_user_input("/exit", mode=PromptMode.SHELL)) is True


def test_visible_slash_command_keeps_expanded_placeholder_args() -> None:
    user_input = UserInput(
        mode=PromptMode.AGENT,
        command="/echo [Pasted text #1 +3 lines]",
        resolved_command="/echo line1\nline2\nline3",
        content=[TextPart(text="line1\nline2\nline3")],
    )

    assert Shell._agent_slash_command_call(user_input) == SlashCommandCall(
        name="echo",
        args="line1\nline2\nline3",
        raw_input="/echo line1\nline2\nline3",
    )
    assert Shell._should_echo_agent_input(user_input) is False


def test_should_not_echo_non_agent_input() -> None:
    assert Shell._should_echo_agent_input(_make_user_input("ls", mode=PromptMode.SHELL)) is False
