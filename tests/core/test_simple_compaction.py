from __future__ import annotations

from inline_snapshot import snapshot
from kosong.message import Message

import kimi_cli.prompts as prompts
from kimi_cli.soul.compaction import SimpleCompaction
from kimi_cli.wire.types import TextPart, ThinkPart


def test_prepare_returns_original_when_not_enough_messages():
    messages = [Message(role="user", content=[TextPart(text="Only one message")])]

    result = SimpleCompaction(max_preserved_messages=2).prepare(messages)

    assert result == snapshot(
        SimpleCompaction.PrepareResult(
            compact_message=None,
            to_preserve=[Message(role="user", content=[TextPart(text="Only one message")])],
        )
    )


def test_prepare_skips_compaction_with_only_preserved_messages():
    messages = [
        Message(role="user", content=[TextPart(text="Latest question")]),
        Message(role="assistant", content=[TextPart(text="Latest reply")]),
    ]

    result = SimpleCompaction(max_preserved_messages=2).prepare(messages)

    assert result == snapshot(
        SimpleCompaction.PrepareResult(
            compact_message=None,
            to_preserve=[
                Message(role="user", content=[TextPart(text="Latest question")]),
                Message(role="assistant", content=[TextPart(text="Latest reply")]),
            ],
        )
    )


def test_prepare_builds_compact_message_and_preserves_tail():
    messages = [
        Message(role="system", content=[TextPart(text="System note")]),
        Message(
            role="user",
            content=[TextPart(text="Old question"), ThinkPart(think="Hidden thoughts")],
        ),
        Message(role="assistant", content=[TextPart(text="Old answer")]),
        Message(role="user", content=[TextPart(text="Latest question")]),
        Message(role="assistant", content=[TextPart(text="Latest answer")]),
    ]

    result = SimpleCompaction(max_preserved_messages=2).prepare(messages)

    assert result.compact_message == snapshot(
        Message(
            role="user",
            content=[
                TextPart(text="## Message 1\nRole: system\nContent:\n"),
                TextPart(text="System note"),
                TextPart(text="## Message 2\nRole: user\nContent:\n"),
                TextPart(text="Old question"),
                TextPart(text="## Message 3\nRole: assistant\nContent:\n"),
                TextPart(text="Old answer"),
                TextPart(text="\n" + prompts.COMPACT),
            ],
        )
    )
    assert result.to_preserve == snapshot(
        [
            Message(role="user", content=[TextPart(text="Latest question")]),
            Message(role="assistant", content=[TextPart(text="Latest answer")]),
        ]
    )


def test_prepare_filters_out_media_parts():
    """Test that image_url, audio_url, and video_url parts are filtered during compaction."""
    from kosong.message import AudioURLPart, ImageURLPart, VideoURLPart

    messages = [
        Message(
            role="user",
            content=[
                TextPart(text="Analyze these files:"),
                ImageURLPart(image_url=ImageURLPart.ImageURL(url="data:image/png;base64,IMG")),
                AudioURLPart(audio_url=AudioURLPart.AudioURL(url="data:audio/mp3;base64,AUD")),
                VideoURLPart(video_url=VideoURLPart.VideoURL(url="data:video/mp4;base64,VID")),
            ],
        ),
        Message(role="assistant", content=[TextPart(text="I can see all the media files.")]),
        Message(role="user", content=[TextPart(text="What's your conclusion?")]),
    ]

    result = SimpleCompaction(max_preserved_messages=1).prepare(messages)

    # The compact message should NOT contain any media parts
    assert result.compact_message == snapshot(
        Message(
            role="user",
            content=[
                TextPart(text="## Message 1\nRole: user\nContent:\n"),
                TextPart(text="Analyze these files:"),
                # Note: image_url, audio_url, video_url are filtered out
                TextPart(text="## Message 2\nRole: assistant\nContent:\n"),
                TextPart(text="I can see all the media files."),
                TextPart(text="\n" + prompts.COMPACT),
            ],
        )
    )

    # Verify no media parts in compact message
    if result.compact_message:
        for part in result.compact_message.content:
            assert not isinstance(part, (ImageURLPart, AudioURLPart, VideoURLPart)), (
                f"Media part {part.type} should be filtered out during compaction"
            )

    # The preserved message should still contain the original content
    assert result.to_preserve == snapshot(
        [Message(role="user", content=[TextPart(text="What's your conclusion?")])]
    )
