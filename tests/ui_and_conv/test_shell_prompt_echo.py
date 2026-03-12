from kosong.message import Message
from rich.text import Text

import kimi_cli.ui.shell as shell_module
from kimi_cli.ui.shell import Shell
from kimi_cli.ui.shell.echo import render_user_echo
from kimi_cli.ui.shell.prompt import PromptMode, UserInput
from kimi_cli.wire.types import AudioURLPart, ImageURLPart, TextPart, VideoURLPart


def _make_user_input(command: str, *, mode: PromptMode = PromptMode.AGENT) -> UserInput:
    return UserInput(
        mode=mode,
        command=command,
        content=[TextPart(text=command)],
    )


def test_echo_agent_input_prints_stringified_user_message(monkeypatch) -> None:
    printed: list[Text] = []
    monkeypatch.setattr(shell_module.console, "print", lambda text: printed.append(text))

    Shell._echo_agent_input(_make_user_input("hi"))

    assert [text.plain for text in printed] == ["✨ hi"]


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


def test_should_not_echo_non_agent_input() -> None:
    assert Shell._should_echo_agent_input(_make_user_input("ls", mode=PromptMode.SHELL)) is False
