from __future__ import annotations

from PIL import Image

from kimi_cli.ui.shell.placeholders import (
    AttachmentCache,
    PromptPlaceholderManager,
    should_placeholderize_pasted_text,
)
from kimi_cli.wire.types import ImageURLPart, TextPart


def test_placeholder_manager_serializes_text_tokens_for_history(tmp_path) -> None:
    manager = PromptPlaceholderManager(attachment_cache=AttachmentCache(root=tmp_path))
    text_token = manager.maybe_placeholderize_pasted_text("alpha\nbeta\ngamma")
    image = Image.new("RGB", (4, 4), color=(10, 20, 30))
    image_token = manager.create_image_placeholder(image)

    assert image_token is not None

    history_text = manager.serialize_for_history(f"before {text_token} {image_token} after")

    assert history_text == f"before alpha\nbeta\ngamma {image_token} after"


def test_placeholder_manager_refolds_editor_text_for_known_text_tokens() -> None:
    manager = PromptPlaceholderManager()
    text_token = manager.maybe_placeholderize_pasted_text("alpha\nbeta\ngamma")
    original_command = f"before {text_token} after"

    refolded = manager.refold_after_editor(
        "before alpha\nbeta\ngamma after\nnotes", original_command
    )

    assert refolded == f"before {text_token} after\nnotes"


def test_placeholder_manager_refolds_original_placeholder_span_not_first_duplicate() -> None:
    manager = PromptPlaceholderManager()
    pasted_text = "alpha\nbeta\ngamma"
    text_token = manager.maybe_placeholderize_pasted_text(pasted_text)
    original_command = f"{pasted_text}\n---\n{text_token}"

    refolded = manager.refold_after_editor(f"{pasted_text}\n---\n{pasted_text}", original_command)

    assert refolded == f"{pasted_text}\n---\n{text_token}"


def test_placeholder_manager_does_not_refold_moved_pasted_text() -> None:
    manager = PromptPlaceholderManager()
    pasted_text = "alpha\nbeta\ngamma"
    text_token = manager.maybe_placeholderize_pasted_text(pasted_text)
    original_command = f"{pasted_text}\n---\n{text_token}"
    edited_text = f"{pasted_text}\n{pasted_text}\n---\n"

    refolded = manager.refold_after_editor(edited_text, original_command)

    assert refolded == edited_text


def test_placeholder_manager_refolds_multiple_unedited_placeholders() -> None:
    manager = PromptPlaceholderManager()
    first = "alpha\nbeta\ngamma"
    second = "one\ntwo\nthree"
    first_token = manager.maybe_placeholderize_pasted_text(first)
    second_token = manager.maybe_placeholderize_pasted_text(second)
    original_command = f"{first_token}\n---\n{second_token}"

    refolded = manager.refold_after_editor(f"{first}\n---\n{second}", original_command)

    assert refolded == original_command


def test_placeholder_manager_only_refolds_unedited_placeholder_when_multiple_exist() -> None:
    manager = PromptPlaceholderManager()
    first = "alpha\nbeta\ngamma"
    second = "one\ntwo\nthree"
    first_token = manager.maybe_placeholderize_pasted_text(first)
    second_token = manager.maybe_placeholderize_pasted_text(second)
    original_command = f"{first_token}\n---\n{second_token}"

    refolded = manager.refold_after_editor(
        f"{first}\n---\none\ntwo changed\nthree", original_command
    )

    assert refolded == f"{first_token}\n---\none\ntwo changed\nthree"


def test_placeholder_manager_leaves_unknown_text_token_literal() -> None:
    manager = PromptPlaceholderManager()

    resolved = manager.resolve_command("[Pasted text #999 +3 lines]")

    assert resolved.resolved_text == "[Pasted text #999 +3 lines]"
    assert resolved.content == [TextPart(text="[Pasted text #999 +3 lines]")]


def test_placeholder_manager_resolves_mixed_text_and_image_tokens(tmp_path) -> None:
    manager = PromptPlaceholderManager(attachment_cache=AttachmentCache(root=tmp_path))
    text_token = manager.maybe_placeholderize_pasted_text("alpha\nbeta\ngamma")
    image = Image.new("RGB", (4, 4), color=(10, 20, 30))
    image_token = manager.create_image_placeholder(image)

    assert image_token is not None

    resolved = manager.resolve_command(f"look {text_token} {image_token}")

    assert resolved.resolved_text == f"look alpha\nbeta\ngamma {image_token}"
    assert resolved.content[0] == TextPart(text="look ")
    assert resolved.content[1] == TextPart(text="alpha\nbeta\ngamma")
    assert resolved.content[2] == TextPart(text=" ")
    assert resolved.content[3].type == "text"
    assert resolved.content[4].type == "image_url"
    assert isinstance(resolved.content[4], ImageURLPart)
    assert resolved.content[5] == TextPart(text="</image>")


def test_placeholder_manager_expands_text_but_not_image_for_editor(tmp_path) -> None:
    manager = PromptPlaceholderManager(attachment_cache=AttachmentCache(root=tmp_path))
    text_token = manager.maybe_placeholderize_pasted_text("alpha\nbeta\ngamma")
    image = Image.new("RGB", (4, 4), color=(10, 20, 30))
    image_token = manager.create_image_placeholder(image)

    assert image_token is not None

    editor_text = manager.expand_for_editor(f"before {text_token} {image_token} after")

    assert editor_text == f"before alpha\nbeta\ngamma {image_token} after"


def test_placeholder_manager_leaves_unknown_image_placeholder_literal() -> None:
    manager = PromptPlaceholderManager()

    resolved = manager.resolve_command("[image:missing.png,10x10]")

    assert resolved.resolved_text == "[image:missing.png,10x10]"
    assert resolved.content == [TextPart(text="[image:missing.png,10x10]")]


def test_placeholder_manager_sanitizes_surrogates_in_pasted_text() -> None:
    manager = PromptPlaceholderManager()
    # Lone surrogate \ud83d (half of an emoji pair) must not survive into the entry.
    text_with_surrogate = "A" * 300 + "\ud83d"
    token = manager.maybe_placeholderize_pasted_text(text_with_surrogate)

    resolved = manager.resolve_command(token)

    # The surrogate must not survive; it is replaced with U+FFFD characters.
    assert "\ud83d" not in resolved.resolved_text
    assert resolved.resolved_text.startswith("A" * 300)
    assert "\ufffd" in resolved.resolved_text

    # Serialization for history must not raise.
    history = manager.serialize_for_history(token)
    assert "\ud83d" not in history


def test_placeholderize_thresholds_cover_char_and_line_boundaries() -> None:
    assert should_placeholderize_pasted_text("A" * 299) is False
    assert should_placeholderize_pasted_text("A" * 300) is True
    assert should_placeholderize_pasted_text("line1\nline2") is False
    assert should_placeholderize_pasted_text("line1\nline2\nline3") is True


def test_placeholder_manager_normalizes_crlf_before_threshold_and_resolution() -> None:
    manager = PromptPlaceholderManager()
    token = manager.maybe_placeholderize_pasted_text("line1\r\nline2\r\nline3")

    assert token == "[Pasted text #1 +3 lines]"

    resolved = manager.resolve_command(token)
    assert resolved.resolved_text == "line1\nline2\nline3"


def test_attachment_cache_loads_legacy_root(tmp_path) -> None:
    legacy_root = tmp_path / "legacy"
    legacy_image_dir = legacy_root / "images"
    legacy_image_dir.mkdir(parents=True)
    attachment_id = "legacy.png"
    payload = b"\x89PNG\r\n\x1a\nlegacy"
    (legacy_image_dir / attachment_id).write_bytes(payload)

    cache = AttachmentCache(root=tmp_path / "new-root", legacy_roots=(legacy_root,))
    loaded = cache.load_bytes("image", attachment_id)

    assert loaded is not None
    path, image_bytes = loaded
    assert path == legacy_image_dir / attachment_id
    assert image_bytes == payload
