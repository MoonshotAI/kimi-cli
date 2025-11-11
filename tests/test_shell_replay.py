from kosong.message import ImageURLPart, Message, TextPart

from kimi_cli.soul.message import TOOL_NON_TEXT_USER_NOTICE, system
from kimi_cli.ui.shell.replay import _is_user_message


def _make_image_part(part_id: str | None = "img-1") -> ImageURLPart:
    return ImageURLPart(
        image_url=ImageURLPart.ImageURL(url="data:image/png;base64,AA==", id=part_id)
    )


def test_is_user_message_accepts_plain_text():
    message = Message(role="user", content="ls")
    assert _is_user_message(message)


def test_is_user_message_accepts_binary_only_input():
    previous = Message(role="assistant", content="done")
    image_message = Message(role="user", content=[_make_image_part()])

    assert _is_user_message(image_message, previous)


def test_is_user_message_skips_checkpoint():
    checkpoint = Message(role="user", content=[system("CHECKPOINT 3")])

    assert not _is_user_message(checkpoint)


def test_is_user_message_ignores_tool_generated_payload():
    tool_message = Message(
        role="tool",
        content=[
            system("Mixed content"),
            system(TOOL_NON_TEXT_USER_NOTICE),
        ],
        tool_call_id="call-123",
    )
    tool_payload = Message(role="user", content=[_make_image_part(part_id=None)])

    assert not _is_user_message(tool_payload, tool_message)


def test_is_user_message_only_checks_for_notice_flag():
    tool_message = Message(
        role="tool",
        content=[TextPart(text="Just a tool log")],
        tool_call_id="call-123",
    )
    user_message = Message(role="user", content=[_make_image_part()])

    assert _is_user_message(user_message, tool_message)
